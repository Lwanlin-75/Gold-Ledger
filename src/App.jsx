import { useState, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient.js";
import {
  Scale,
  Plus,
  Trash2,
  Save,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  History,
  Download,
  Archive,
  X,
  Lock,
  Truck,
  ArrowLeftRight,
  Users,
} from "lucide-react";

const WORKERS = ["JJ", "PD Lv2", "PD Lv1", "倒模", "Lv1车花", "Lv1倒模"];
const OTHER_DESTINATIONS = [
  "老板",
  "现货",
  "PD门市",
  "JJ门市",
  "TUN/ABAD",
  "REPAIR",
  "OTHER",
];
const LOSS_THRESHOLD = 1; // 克，超过这个数就标红提醒
// 过秤时是连盒子一起秤的，这里是盒重的默认起始值，实际值可以在网页里改，不是写死的
const BOX_WEIGHT_DEFAULTS = { JJ: 200.38, "PD Lv1": 212.37, "PD Lv2": 722.42 };
function defaultBoxWeight(worker) {
  return BOX_WEIGHT_DEFAULTS[worker] ?? 0;
}

const SPECIAL_KEYS = { SHIPMENTS: "__SHIPMENTS__", TRANSFERS: "__TRANSFERS__" };
const SHIP_WORKERS = ["JJ", "PD Lv2", "Lv1车花"];
const SHIP_TO = "PD门市";
const SHIP_CATEGORIES = ["戒指", "链", "牌", "OTHER"];
const DENOM_TOLERANCE = 0.03; // 克，GOLDBAR/GOLDBEAN 实重跟小计差超过这个数要二次确认
const DENOMINATIONS = [
  { key: "0.10", label: "0.10", grams: 0.1 },
  { key: "0.20", label: "0.20", grams: 0.2 },
  { key: "0.50", label: "0.50", grams: 0.5 },
  { key: "1.00", label: "1.00", grams: 1.0 },
  { key: "half_dinar", label: "1/2 DINAR", grams: 2.125 },
  { key: "dinar", label: "DINAR", grams: 4.25 },
  { key: "5.00", label: "5.00", grams: 5.0 },
  { key: "10.00", label: "10.00", grams: 10.0 },
  { key: "20.00", label: "20.00", grams: 20.0 },
  { key: "50.00", label: "50.00", grams: 50.0 },
  { key: "100.00", label: "100.00", grams: 100.0 },
];
const TRANSFER_TYPE_PRESETS = ["掉色来回", "Lv1↔Lv2上下楼"];
// 送出/接收时流水描述的默认建议，都可以在填的时候自己改
const LABEL_HINTS = {
  "掉色来回": {
    JJ: { send: "出 掉色", receive: "加 掉色" },
    "PD Lv2": { send: "出 掉色", receive: "回 掉色" },
  },
  "Lv1↔Lv2上下楼": {
    "PD Lv1": { send: "上楼", receive: "做工" },
    "PD Lv2": { send: "下楼", receive: "上楼" },
  },
};
function suggestLabel(type, worker, direction) {
  const hint = LABEL_HINTS[type] && LABEL_HINTS[type][worker];
  if (hint && hint[direction]) return hint[direction];
  return direction === "send" ? `出 ${type}` : `加 ${type}`;
}

const emptyShipmentData = () => ({ nextSerial: 2608081, threshold: 0.05, history: [] });

function calcDenomState(qty, actualStr) {
  const calc = denomTotal(qty);
  const actual = actualStr === "" ? null : parseFloat(actualStr);
  const diff = actual !== null && !Number.isNaN(actual) ? actual - calc : null;
  const overTolerance = diff !== null && Math.abs(diff) > DENOM_TOLERANCE;
  const finalWeight = actual !== null && !Number.isNaN(actual) ? actual : calc;
  return { calc, actual, diff, overTolerance, finalWeight };
}
const emptyTransferData = () => ({ threshold: 0.05, history: [] });

function denomTotal(qtyObj) {
  return DENOMINATIONS.reduce(
    (s, d) => s + (parseFloat(qtyObj[d.key] || 0) || 0) * d.grams,
    0
  );
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const r = Math.round(n * 100) / 100;
  return (r > 0 ? "+" : "") + r.toFixed(2);
}

function fmtPlain(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function destinationsFor(worker) {
  return ["", ...WORKERS.filter((w) => w !== worker), ...OTHER_DESTINATIONS];
}

const emptyWorkerData = () => ({ lastWeight: null, history: [], drafts: {} });

// 中英文对照：t(中文, 英文) —— lang由组件内部state决定，这里只是工厂函数
function makeT(lang) {
  return (zh, en) => (lang === "en" ? en : zh);
}

// 按顺序重新计算整条历史链：非归档记录用流水重新算 total/要有/损耗，
// 归档记录（exported）明细已清空，冻结原本算好的数字不动，只跟着更新 prevWeight。
function recomputeChain(history) {
  let prev = null;
  const next = history.map((r) => {
    if (r.exported) {
      const updated = { ...r, prevWeight: prev };
      prev = r.actual;
      return updated;
    }
    const total = (r.transactions || []).reduce((s, t) => s + t.amount, 0);
    const expected = prev !== null ? prev + total : null;
    const loss = expected !== null ? r.actual - expected : null;
    const updated = { ...r, prevWeight: prev, total, expected, loss };
    prev = r.actual;
    return updated;
  });
  return next;
}

export default function GoldLedger() {
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem("gl_lang") || "zh";
    } catch {
      return "zh";
    }
  });
  const t = makeT(lang);
  function toggleLang() {
    setLang((l) => {
      const next = l === "zh" ? "en" : "zh";
      try {
        localStorage.setItem("gl_lang", next);
      } catch {}
      return next;
    });
  }

  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [data, setData] = useState(() =>
    Object.fromEntries(WORKERS.map((w) => [w, emptyWorkerData()]))
  );
  const [activeWorker, setActiveWorker] = useState(WORKERS[0]);
  const [descInput, setDescInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [destInput, setDestInput] = useState("");
  const [rowError, setRowError] = useState("");
  const [actualInput, setActualInput] = useState("");
  const [boxWeightDraft, setBoxWeightDraft] = useState("");
  const [recoverInput, setRecoverInput] = useState("0");
  const [actualError, setActualError] = useState("");
  const [dateInput, setDateInput] = useState(todayStr());
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);

  // 导出 / 归档
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [pendingExportKeys, setPendingExportKeys] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // 详情弹窗
  const [showDetail, setShowDetail] = useState(null); // { worker, index } | null
  const [editTransactions, setEditTransactions] = useState([]);
  const [editActual, setEditActual] = useState("");
  const [editDate, setEditDate] = useState("");
  const [detailDesc, setDetailDesc] = useState("");
  const [detailAmount, setDetailAmount] = useState("");
  const [detailDest, setDetailDest] = useState("");
  const [detailRowError, setDetailRowError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailSaving, setDetailSaving] = useState(false);

  // 页面切换：对账 / 出货记录 / 转手核对
  const [view, setView] = useState("workers");

  // 出货记录
  const [shipmentData, setShipmentData] = useState(emptyShipmentData());
  const [shipFrom, setShipFrom] = useState(SHIP_WORKERS[0]);
  const [shipDate, setShipDate] = useState(todayStr());
  const [shipCategory, setShipCategory] = useState(SHIP_CATEGORIES[0]);
  const [shipCategoryCustom, setShipCategoryCustom] = useState("");
  const [shipWeight, setShipWeight] = useState("");
  const [shipItems, setShipItems] = useState([]);
  const [shipRowError, setShipRowError] = useState("");
  const [goldbarQty, setGoldbarQty] = useState({});
  const [goldbeanQty, setGoldbeanQty] = useState({});
  const [goldbarActual, setGoldbarActual] = useState("");
  const [goldbeanActual, setGoldbeanActual] = useState("");
  const [goldbarConfirmed, setGoldbarConfirmed] = useState(false);
  const [goldbeanConfirmed, setGoldbeanConfirmed] = useState(false);
  const [shipFlowDesc, setShipFlowDesc] = useState("出货");
  const [shipSaving, setShipSaving] = useState(false);
  const [shipMsg, setShipMsg] = useState("");
  const [shipThresholdDraft, setShipThresholdDraft] = useState("0.05");
  const [shipConfirmingId, setShipConfirmingId] = useState(null);
  const [shipConfirmDate, setShipConfirmDate] = useState(todayStr());
  const [shipConfirmWeight, setShipConfirmWeight] = useState("");
  const [shipConfirmSerial, setShipConfirmSerial] = useState("");
  const [shipConfirmError, setShipConfirmError] = useState("");
  const [shipConfirmSaving, setShipConfirmSaving] = useState(false);

  // 转手核对
  const [transferData, setTransferData] = useState(emptyTransferData());
  const [thresholdDraft, setThresholdDraft] = useState("0.05");
  const [transType, setTransType] = useState(TRANSFER_TYPE_PRESETS[0]);
  const [transTypeCustom, setTransTypeCustom] = useState("");
  const [transFrom, setTransFrom] = useState(WORKERS[0]);
  const [transTo, setTransTo] = useState(WORKERS[1]);
  const [transSentDate, setTransSentDate] = useState(todayStr());
  const [transSentWeight, setTransSentWeight] = useState("");
  const [transSentDesc, setTransSentDesc] = useState("");
  const [transError, setTransError] = useState("");
  const [transSaving, setTransSaving] = useState(false);
  const [transMsg, setTransMsg] = useState("");
  const [confirmingId, setConfirmingId] = useState(null);
  const [confirmDate, setConfirmDate] = useState(todayStr());
  const [confirmWeight, setConfirmWeight] = useState("");
  const [confirmDesc, setConfirmDesc] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [confirmSaving, setConfirmSaving] = useState(false);

  // 转手核对：一次性登记（送出+接收一起填）
  const [showQuickTransfer, setShowQuickTransfer] = useState(false);
  const [quickType, setQuickType] = useState(TRANSFER_TYPE_PRESETS[0]);
  const [quickTypeCustom, setQuickTypeCustom] = useState("");
  const [quickFrom, setQuickFrom] = useState(WORKERS[0]);
  const [quickTo, setQuickTo] = useState(WORKERS[1]);
  const [quickSentDate, setQuickSentDate] = useState(todayStr());
  const [quickSentWeight, setQuickSentWeight] = useState("");
  const [quickSentDesc, setQuickSentDesc] = useState("");
  const [quickReceivedDate, setQuickReceivedDate] = useState(todayStr());
  const [quickReceivedWeight, setQuickReceivedWeight] = useState("");
  const [quickReceivedDesc, setQuickReceivedDesc] = useState("");
  const [quickError, setQuickError] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickMsg, setQuickMsg] = useState("");

  // 账号管理（仅admin）
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminUsersLoading, setAdminUsersLoading] = useState(false);
  const [adminUsersError, setAdminUsersError] = useState("");
  const [deletingUserId, setDeletingUserId] = useState(null);

  const isAdmin = role === "admin";

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setSession(data.session);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setRole(null);
      setAuthChecked(true);
      return;
    }
    let cancelled = false;
    supabase
      .from("profiles")
      .select("role")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        setRole(error ? "user" : data?.role || "user");
        setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoginBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password: loginPassword,
    });
    if (error) setLoginError("登录失败：账号或密码不对");
    setLoginBusy(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setReady(false);
  }

  async function refreshWorkerData(worker) {
    const { data: rows, error } = await supabase.rpc("get_ledger_rows", {
      p_keys: [worker],
    });
    if (error) return;
    const row = (rows || [])[0];
    setData((d) => ({
      ...d,
      [worker]: row ? { ...emptyWorkerData(), ...(row.data || {}) } : emptyWorkerData(),
    }));
  }

  useEffect(() => {
    if (!session || !role) return;
    let cancelled = false;
    async function load() {
      const { data: rows, error } = await supabase.rpc("get_ledger_rows", {
        p_keys: WORKERS,
      });
      if (error) throw error;
      const next = Object.fromEntries(WORKERS.map((w) => [w, emptyWorkerData()]));
      for (const row of rows || []) {
        next[row.worker] = { ...emptyWorkerData(), ...(row.data || {}) };
      }
      const { data: shipRaw, error: shipErr } = await supabase.rpc("get_special_row", {
        p_key: SPECIAL_KEYS.SHIPMENTS,
      });
      if (shipErr) throw shipErr;
      const nextShipments = { ...emptyShipmentData(), ...(shipRaw || {}) };
      const { data: transRaw, error: transErr } = await supabase.rpc("get_special_row", {
        p_key: SPECIAL_KEYS.TRANSFERS,
      });
      if (transErr) throw transErr;
      const nextTransfers = { ...emptyTransferData(), ...(transRaw || {}) };
      if (!cancelled) {
        setData(next);
        setShipmentData(nextShipments);
        setTransferData(nextTransfers);
        setThresholdDraft(String(nextTransfers.threshold ?? 0.05));
        setShipThresholdDraft(String(nextShipments.threshold ?? 0.05));
        setReady(true);
      }
    }
    load().catch(() => {
      if (!cancelled) {
        setLoadError("读取记录失败（检查网络或权限），先从空白开始，保存时会重试。");
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session, role]);

  useEffect(() => {
    const type = transType === "OTHER" ? transTypeCustom.trim() || "转手" : transType;
    setTransSentDesc(suggestLabel(type, transFrom, "send"));
  }, [transType, transTypeCustom, transFrom]);

  useEffect(() => {
    const type = quickType === "OTHER" ? quickTypeCustom.trim() || "转手" : quickType;
    setQuickSentDesc(suggestLabel(type, quickFrom, "send"));
  }, [quickType, quickTypeCustom, quickFrom]);

  useEffect(() => {
    const type = quickType === "OTHER" ? quickTypeCustom.trim() || "转手" : quickType;
    setQuickReceivedDesc(suggestLabel(type, quickTo, "receive"));
  }, [quickType, quickTypeCustom, quickTo]);

  useEffect(() => {
    setGoldbarConfirmed(false);
  }, [goldbarQty, goldbarActual]);
  useEffect(() => {
    setGoldbeanConfirmed(false);
  }, [goldbeanQty, goldbeanActual]);

  const goldbarState = calcDenomState(goldbarQty, goldbarActual);
  const goldbeanState = calcDenomState(goldbeanQty, goldbeanActual);

  const cur = data[activeWorker] || emptyWorkerData();

  useEffect(() => {
    if (!ready) return;
    const bw = cur.boxWeight != null ? cur.boxWeight : defaultBoxWeight(activeWorker);
    setBoxWeightDraft(String(bw));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorker, ready]);

  async function saveBoxWeight() {
    if (!isAdmin) return;
    const v = parseFloat(boxWeightDraft);
    if (Number.isNaN(v) || v < 0) return;
    try {
      const { error } = await supabase.rpc("update_special_field", {
        p_key: activeWorker,
        p_field: "boxWeight",
        p_value: v,
      });
      if (error) throw error;
      setData((d) => ({
        ...d,
        [activeWorker]: { ...(d[activeWorker] || emptyWorkerData()), boxWeight: v },
      }));
      setSaveMsg("已更新盒重");
    } catch {
      setSaveMsg("更新盒重失败，检查网络后重试");
    }
  }

  const curDraft = (cur.drafts && cur.drafts[dateInput]) || [];
  const totalChange = useMemo(
    () => curDraft.reduce((s, t) => s + t.amount, 0),
    [curDraft]
  );
  const hasBaseline = cur.lastWeight !== null;
  const expected = hasBaseline ? cur.lastWeight + totalChange : null;
  const destinations = useMemo(() => destinationsFor(activeWorker), [activeWorker]);

  const rawScaleNum = actualInput === "" ? null : parseFloat(actualInput);
  const boxWeightNum = boxWeightDraft === "" ? 0 : parseFloat(boxWeightDraft) || 0;
  const recoverNum = recoverInput === "" ? 0 : parseFloat(recoverInput) || 0;
  const actualNum =
    rawScaleNum !== null && !Number.isNaN(rawScaleNum)
      ? rawScaleNum - boxWeightNum + recoverNum
      : null;
  const loss =
    hasBaseline && actualNum !== null && !Number.isNaN(actualNum)
      ? actualNum - expected
      : null;
  const lossOver = loss !== null && Math.abs(loss) > LOSS_THRESHOLD;

  function addRow() {
    const amt = parseFloat(amountInput);
    if (!descInput.trim()) {
      setRowError("请填写描述");
      return;
    }
    if (amountInput === "" || Number.isNaN(amt) || amt === 0) {
      setRowError("请填写有效的加减数量（不能为0）");
      return;
    }
    const item = { id: String(Date.now() + Math.random()), desc: descInput.trim(), amount: amt, dest: destInput };
    addDraftItemLocal(activeWorker, dateInput, item);
    setDescInput("");
    setAmountInput("");
    setDestInput("");
    setRowError("");
  }

  function removeRow(id) {
    removeDraftItemLocal(activeWorker, dateInput, id);
  }

  // 加一条暂存流水（本地立即显示 + 后台走安全通道同步，user也能用）
  function addDraftItemLocal(worker, date, item) {
    setData((d) => {
      const workerData = d[worker] || emptyWorkerData();
      const list = (workerData.drafts && workerData.drafts[date]) || [];
      const nextDrafts = { ...(workerData.drafts || {}), [date]: [...list, item] };
      return { ...d, [worker]: { ...workerData, drafts: nextDrafts } };
    });
    supabase.rpc("upsert_draft_item", { p_worker: worker, p_date: date, p_item: item }).then(({ error }) => {
      if (error) setSaveMsg("同步失败，检查网络（这条记录可能还没同步到其他设备）");
    });
  }

  // 删一条暂存流水
  function removeDraftItemLocal(worker, date, itemId) {
    setData((d) => {
      const workerData = d[worker] || emptyWorkerData();
      const list = (workerData.drafts && workerData.drafts[date]) || [];
      const filtered = list.filter((t) => t.id !== itemId);
      const nextDrafts = { ...(workerData.drafts || {}) };
      if (filtered.length === 0) delete nextDrafts[date];
      else nextDrafts[date] = filtered;
      return { ...d, [worker]: { ...workerData, drafts: nextDrafts } };
    });
    supabase
      .rpc("remove_draft_item", { p_worker: worker, p_date: date, p_item_id: String(itemId) })
      .then(({ error }) => {
        if (error) setSaveMsg("同步失败，检查网络（这条记录可能还没同步到其他设备）");
      });
  }

  // 整包写回只给 admin 用（撤销、编辑历史、导出后清空、改阈值等）
  async function persistRow(key, nextData) {
    if (!isAdmin) throw new Error("not authorized");
    const { error } = await supabase.rpc("admin_upsert_row", {
      p_worker: key,
      p_data: nextData,
    });
    if (error) throw error;
  }
  const persistWorker = persistRow;

  async function refreshSpecialData(key, setter, emptyFn) {
    const { data: raw, error } = await supabase.rpc("get_special_row", { p_key: key });
    if (error) return;
    setter({ ...emptyFn(), ...(raw || {}) });
  }

  // ---- 出货记录 ----
  function addShipItem() {
    const cat = shipCategory === "OTHER" ? shipCategoryCustom.trim() : shipCategory;
    const w = parseFloat(shipWeight);
    if (!cat) {
      setShipRowError("请填写类别");
      return;
    }
    if (shipWeight === "" || Number.isNaN(w) || w <= 0) {
      setShipRowError("请填写有效重量");
      return;
    }
    setShipItems((list) => [
      ...list,
      { id: Date.now() + Math.random(), category: cat, weight: w },
    ]);
    setShipCategoryCustom("");
    setShipWeight("");
    setShipRowError("");
  }

  function removeShipItem(id) {
    setShipItems((list) => list.filter((i) => i.id !== id));
  }

  function itemsSummary(items) {
    return (items || []).map((i) => `${i.category} ${fmtPlain(i.weight)}g`).join("、");
  }

  function canSaveShipment() {
    if (goldbarState.overTolerance && !goldbarConfirmed) return false;
    if (goldbeanState.overTolerance && !goldbeanConfirmed) return false;
    return true;
  }

  async function saveShipThreshold() {
    if (!isAdmin) return;
    const t = parseFloat(shipThresholdDraft);
    if (Number.isNaN(t) || t < 0) return;
    const nextData = { ...shipmentData, threshold: t };
    try {
      await persistRow(SPECIAL_KEYS.SHIPMENTS, nextData);
      setShipmentData(nextData);
    } catch {
      setShipMsg("阈值更新失败，检查网络后重试");
    }
  }

  async function saveShipment() {
    setShipMsg("");
    if (!canSaveShipment()) {
      setShipMsg("GOLDBAR 或 GOLDBEAN 的实重跟小计差超过0.03g，请先点下面的确认按钮再保存");
      return;
    }
    const items = [...shipItems];
    if (goldbarState.finalWeight > 0) {
      items.push({
        id: Date.now() + Math.random(),
        category: "GOLDBAR",
        weight: Math.round(goldbarState.finalWeight * 100) / 100,
      });
    }
    if (goldbeanState.finalWeight > 0) {
      items.push({
        id: Date.now() + Math.random(),
        category: "GOLDBEAN",
        weight: Math.round(goldbeanState.finalWeight * 100) / 100,
      });
    }
    if (items.length === 0) {
      setShipMsg("请至少添加一项出货内容");
      return;
    }
    if (!shipFlowDesc.trim()) {
      setShipMsg("请填写流水描述");
      return;
    }
    setShipSaving(true);
    const sentTotal = items.reduce((s, i) => s + i.weight, 0);
    const sentItemId = String(Date.now() + Math.random());
    const record = {
      id: String(Date.now() + Math.random()),
      serial: "",
      fromWorker: shipFrom,
      toWorker: SHIP_TO,
      date: shipDate,
      items,
      denom: { goldbar: { ...goldbarQty }, goldbean: { ...goldbeanQty } },
      denomActual: { goldbar: goldbarState.actual, goldbean: goldbeanState.actual },
      sentTotal,
      sentItemId,
      status: "pending",
      confirmDate: null,
      confirmWeight: null,
      diff: null,
    };
    const categoryList = [...new Set(items.map((i) => i.category))].join("、");
    const autoDesc = `${shipFlowDesc.trim()} ${categoryList}`.trim();
    addDraftItemLocal(shipFrom, shipDate, {
      id: sentItemId,
      desc: autoDesc,
      amount: -sentTotal,
      dest: SHIP_TO,
    });
    try {
      const { error } = await supabase.rpc("append_special_record", {
        p_key: SPECIAL_KEYS.SHIPMENTS,
        p_record: record,
      });
      if (error) throw error;
      await refreshSpecialData(SPECIAL_KEYS.SHIPMENTS, setShipmentData, emptyShipmentData);
      setShipItems([]);
      setGoldbarQty({});
      setGoldbeanQty({});
      setGoldbarActual("");
      setGoldbeanActual("");
      setGoldbarConfirmed(false);
      setGoldbeanConfirmed(false);
      setShipDate(todayStr());
      setShipFlowDesc("出货");
      setShipMsg(`已保存，已写入 ${shipFrom} 流水，等待${SHIP_TO}确认接收并填写单号。`);
    } catch {
      setShipMsg("保存失败，检查网络后重试");
    } finally {
      setShipSaving(false);
    }
  }

  function openShipConfirm(record) {
    setShipConfirmingId(record.id);
    setShipConfirmDate(todayStr());
    setShipConfirmWeight("");
    setShipConfirmSerial("");
    setShipConfirmError("");
  }

  async function confirmShipment() {
    setShipConfirmError("");
    const record = shipmentData.history.find((r) => r.id === shipConfirmingId);
    if (!record) return;
    const w = parseFloat(shipConfirmWeight);
    if (shipConfirmWeight === "" || Number.isNaN(w) || w <= 0) {
      setShipConfirmError(`请填写有效的${SHIP_TO}重量`);
      return;
    }
    if (!shipConfirmSerial.trim()) {
      setShipConfirmError("请填写单号");
      return;
    }
    setShipConfirmSaving(true);
    try {
      const { error } = await supabase.rpc("update_special_record", {
        p_key: SPECIAL_KEYS.SHIPMENTS,
        p_record_id: record.id,
        p_patch: {
          status: "confirmed",
          confirmDate: shipConfirmDate,
          confirmWeight: w,
          serial: shipConfirmSerial.trim(),
          diff: w - record.sentTotal,
        },
      });
      if (error) throw error;
      await refreshSpecialData(SPECIAL_KEYS.SHIPMENTS, setShipmentData, emptyShipmentData);
      setShipConfirmingId(null);
    } catch {
      setShipConfirmError("保存失败，检查网络后重试");
    } finally {
      setShipConfirmSaving(false);
    }
  }

  function deleteShipmentRecord(record) {
    if (!isAdmin) return;
    const msg =
      record.status === "pending"
        ? "确定取消这笔待确认的出货？（已写进流水的那条也会撤销）"
        : "确定删除这条已确认的出货记录？";
    if (!window.confirm(msg)) return;
    if (record.sentItemId) {
      removeDraftItemLocal(record.fromWorker, record.date, record.sentItemId);
    }
    supabase
      .rpc("admin_delete_special_record", { p_key: SPECIAL_KEYS.SHIPMENTS, p_record_id: record.id })
      .then(({ error }) => {
        if (error) {
          setShipMsg("删除失败，检查网络后重试");
        } else {
          refreshSpecialData(SPECIAL_KEYS.SHIPMENTS, setShipmentData, emptyShipmentData);
        }
      });
  }

  async function loadAdminUsers() {
    setAdminUsersLoading(true);
    setAdminUsersError("");
    const { data: rows, error } = await supabase
      .from("profiles")
      .select("id, email, role, created_at")
      .order("created_at", { ascending: true });
    if (error) {
      setAdminUsersError("读取账号列表失败");
    } else {
      setAdminUsers(rows || []);
    }
    setAdminUsersLoading(false);
  }

  useEffect(() => {
    if (view === "admin" && isAdmin) {
      loadAdminUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, isAdmin]);

  async function deleteUser(userId) {
    if (!window.confirm("确定删除这个账号？删除后这个人就没法登录了。")) return;
    setDeletingUserId(userId);
    setAdminUsersError("");
    const { error } = await supabase.functions.invoke("delete-user", {
      body: { user_id: userId },
    });
    if (error) {
      setAdminUsersError("删除失败：后台删除账号的功能还没部署，需要先部署 Edge Function");
    } else {
      await loadAdminUsers();
    }
    setDeletingUserId(null);
  }

  const pendingShipments = useMemo(
    () =>
      shipmentData.history
        .filter((r) => r.status === "pending")
        .sort((a, b) => b.date.localeCompare(a.date)),
    [shipmentData.history]
  );
  const confirmedShipments = useMemo(
    () =>
      shipmentData.history
        .filter((r) => r.status === "confirmed")
        .sort((a, b) => b.date.localeCompare(a.date)),
    [shipmentData.history]
  );


  // ---- 转手核对 ----
  async function saveThreshold() {
    if (!isAdmin) return;
    const t = parseFloat(thresholdDraft);
    if (Number.isNaN(t) || t < 0) return;
    const nextData = { ...transferData, threshold: t };
    try {
      await persistRow(SPECIAL_KEYS.TRANSFERS, nextData);
      setTransferData(nextData);
    } catch {
      setTransMsg("阈值更新失败，检查网络后重试");
    }
  }

  // 送出方先保存（半保存），自动写入送出方当天流水（减）
  async function saveSentHalf() {
    setTransError("");
    setTransMsg("");
    const type = transType === "OTHER" ? transTypeCustom.trim() : transType;
    const weight = parseFloat(transSentWeight);
    if (!type) {
      setTransError("请填写类型");
      return;
    }
    if (transFrom === transTo) {
      setTransError("送出方和接收方不能是同一个");
      return;
    }
    if (transSentWeight === "" || Number.isNaN(weight) || weight <= 0) {
      setTransError("请填写有效的送出方重量");
      return;
    }
    if (!transSentDesc.trim()) {
      setTransError("请填写送出方的流水描述");
      return;
    }
    setTransSaving(true);
    const sentItemId = String(Date.now() + Math.random());
    const record = {
      id: String(Date.now() + Math.random()),
      type,
      fromWorker: transFrom,
      toWorker: transTo,
      sentDate: transSentDate,
      sentWeight: weight,
      sentDesc: transSentDesc.trim(),
      sentItemId,
      receivedDate: null,
      receivedWeight: null,
      receivedDesc: null,
      receivedItemId: null,
      status: "pending",
      diff: null,
    };
    addDraftItemLocal(transFrom, transSentDate, {
      id: sentItemId,
      desc: transSentDesc.trim(),
      amount: -weight,
      dest: transTo,
    });
    try {
      const { error } = await supabase.rpc("append_special_record", {
        p_key: SPECIAL_KEYS.TRANSFERS,
        p_record: record,
      });
      if (error) throw error;
      await refreshSpecialData(SPECIAL_KEYS.TRANSFERS, setTransferData, emptyTransferData);
      setTransSentWeight("");
      setTransMsg(`已保存送出方重量，已经写进 ${transFrom} 当天流水，等 ${transTo} 收到后来确认。`);
    } catch {
      setTransMsg("保存失败，检查网络后重试");
    } finally {
      setTransSaving(false);
    }
  }

  // 一次性登记：送出+接收一起填，保存后两边流水一次写进去，直接是已确认状态
  async function saveQuickTransfer() {
    setQuickError("");
    setQuickMsg("");
    const type = quickType === "OTHER" ? quickTypeCustom.trim() : quickType;
    const sentW = parseFloat(quickSentWeight);
    const receivedW = parseFloat(quickReceivedWeight);
    if (!type) {
      setQuickError("请填写类型");
      return;
    }
    if (quickFrom === quickTo) {
      setQuickError("送出方和接收方不能是同一个");
      return;
    }
    if (quickSentWeight === "" || Number.isNaN(sentW) || sentW <= 0) {
      setQuickError("请填写有效的送出方重量");
      return;
    }
    if (quickReceivedWeight === "" || Number.isNaN(receivedW) || receivedW <= 0) {
      setQuickError("请填写有效的接收方重量");
      return;
    }
    if (!quickSentDesc.trim()) {
      setQuickError("请填写送出方的流水描述");
      return;
    }
    if (!quickReceivedDesc.trim()) {
      setQuickError("请填写接收方的流水描述");
      return;
    }
    setQuickSaving(true);
    const sentItemId = String(Date.now() + Math.random());
    const receivedItemId = String(Date.now() + Math.random() + 1);
    const record = {
      id: String(Date.now() + Math.random()),
      type,
      fromWorker: quickFrom,
      toWorker: quickTo,
      sentDate: quickSentDate,
      sentWeight: sentW,
      sentDesc: quickSentDesc.trim(),
      sentItemId,
      receivedDate: quickReceivedDate,
      receivedWeight: receivedW,
      receivedDesc: quickReceivedDesc.trim(),
      receivedItemId,
      status: "confirmed",
      diff: receivedW - sentW,
    };
    addDraftItemLocal(quickFrom, quickSentDate, {
      id: sentItemId,
      desc: quickSentDesc.trim(),
      amount: -sentW,
      dest: quickTo,
    });
    addDraftItemLocal(quickTo, quickReceivedDate, {
      id: receivedItemId,
      desc: quickReceivedDesc.trim(),
      amount: receivedW,
      dest: quickFrom,
    });
    try {
      const { error } = await supabase.rpc("append_special_record", {
        p_key: SPECIAL_KEYS.TRANSFERS,
        p_record: record,
      });
      if (error) throw error;
      await refreshSpecialData(SPECIAL_KEYS.TRANSFERS, setTransferData, emptyTransferData);
      setQuickSentWeight("");
      setQuickReceivedWeight("");
      setQuickMsg(`已保存，${quickFrom} 和 ${quickTo} 的流水都已经写进去了。`);
    } catch {
      setQuickMsg("保存失败，检查网络后重试");
    } finally {
      setQuickSaving(false);
    }
  }

  function openConfirm(record) {
    setConfirmingId(record.id);
    setConfirmDate(todayStr());
    setConfirmWeight("");
    setConfirmDesc(suggestLabel(record.type, record.toWorker, "receive"));
    setConfirmError("");
  }

  // 接收方确认收到，自动写入接收方当天流水（加），并算差异
  async function confirmReceived() {
    setConfirmError("");
    const record = transferData.history.find((r) => r.id === confirmingId);
    if (!record) return;
    const weight = parseFloat(confirmWeight);
    if (confirmWeight === "" || Number.isNaN(weight) || weight <= 0) {
      setConfirmError("请填写有效的接收方重量");
      return;
    }
    if (!confirmDesc.trim()) {
      setConfirmError("请填写接收方的流水描述");
      return;
    }
    setConfirmSaving(true);
    const receivedItemId = String(Date.now() + Math.random());
    addDraftItemLocal(record.toWorker, confirmDate, {
      id: receivedItemId,
      desc: confirmDesc.trim(),
      amount: weight,
      dest: record.fromWorker,
    });
    try {
      const { error } = await supabase.rpc("update_special_record", {
        p_key: SPECIAL_KEYS.TRANSFERS,
        p_record_id: record.id,
        p_patch: {
          receivedDate: confirmDate,
          receivedWeight: weight,
          receivedDesc: confirmDesc.trim(),
          receivedItemId,
          status: "confirmed",
          diff: weight - record.sentWeight,
        },
      });
      if (error) throw error;
      await refreshSpecialData(SPECIAL_KEYS.TRANSFERS, setTransferData, emptyTransferData);
      setConfirmingId(null);
    } catch {
      setConfirmError("保存失败，检查网络后重试");
    } finally {
      setConfirmSaving(false);
    }
  }

  function deleteTransferRecord(record) {
    if (!isAdmin) return;
    const msg =
      record.status === "pending"
        ? "确定取消这笔待确认的核对？（已经写进送出方流水的那条也会一起撤销）"
        : "确定删除这条已确认的核对记录？（如果对应流水已经存档保存过，需要去对账页面手动调整）";
    if (!window.confirm(msg)) return;
    if (record.sentItemId) {
      removeDraftItemLocal(record.fromWorker, record.sentDate, record.sentItemId);
    }
    if (record.receivedItemId) {
      removeDraftItemLocal(record.toWorker, record.receivedDate, record.receivedItemId);
    }
    supabase
      .rpc("admin_delete_special_record", { p_key: SPECIAL_KEYS.TRANSFERS, p_record_id: record.id })
      .then(({ error }) => {
        if (error) {
          setTransMsg("删除失败，检查网络后重试");
        } else {
          refreshSpecialData(SPECIAL_KEYS.TRANSFERS, setTransferData, emptyTransferData);
        }
      });
  }

  const pendingTransfers = useMemo(
    () =>
      transferData.history
        .filter((r) => r.status === "pending")
        .sort((a, b) => b.sentDate.localeCompare(a.sentDate)),
    [transferData.history]
  );
  const confirmedTransfers = useMemo(
    () =>
      transferData.history
        .filter((r) => r.status === "confirmed")
        .sort((a, b) => b.receivedDate.localeCompare(a.receivedDate)),
    [transferData.history]
  );

  async function saveDay() {
    setActualError("");
    setSaveMsg("");
    if (actualInput === "" || Number.isNaN(rawScaleNum)) {
      setActualError("请填写这一天过秤读到的重量");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc("save_day", {
        p_worker: activeWorker,
        p_date: dateInput,
        p_actual: actualNum,
      });
      if (error) throw error;
      await refreshWorkerData(activeWorker);
      setActualInput("");
      setRecoverInput("0");
      setDateInput(todayStr());
      setSaveMsg("已保存这一天的记录");
    } catch {
      setSaveMsg("保存失败，检查网络或权限，请重试一次");
    } finally {
      setSaving(false);
    }
  }

  async function undoLastDay() {
    if (!isAdmin) return;
    if (cur.history.length === 0) return;
    setUndoing(true);
    const newHistory = recomputeChain(cur.history.slice(0, -1));
    const prevWeight =
      newHistory.length > 0 ? newHistory[newHistory.length - 1].actual : null;
    const nextWorkerData = { lastWeight: prevWeight, history: newHistory, drafts: cur.drafts || {} };
    try {
      await persistWorker(activeWorker, nextWorkerData);
      setData((d) => ({ ...d, [activeWorker]: nextWorkerData }));
      setSaveMsg("已撤销最近一天的记录");
    } catch {
      setSaveMsg("撤销失败，检查网络后重试");
    } finally {
      setUndoing(false);
      setConfirmUndo(false);
    }
  }

  const recentHistory = useMemo(
    () =>
      cur.history
        .map((r, i) => ({ ...r, _idx: i }))
        .slice(-14)
        .reverse(),
    [cur.history]
  );
  const cumulativeLoss = cur.history.reduce((s, r) => s + (r.loss || 0), 0);

  // ---- 详情弹窗 ----
  function openDetail(worker, idx) {
    const record = data[worker].history[idx];
    setShowDetail({ worker, index: idx });
    setEditTransactions((record.transactions || []).map((t) => ({ ...t })));
    setEditActual(String(record.actual));
    setEditDate(record.date);
    setDetailDesc("");
    setDetailAmount("");
    setDetailDest("");
    setDetailRowError("");
    setDetailError("");
  }

  function closeDetail() {
    setShowDetail(null);
  }

  function addDetailRow() {
    const amt = parseFloat(detailAmount);
    if (!detailDesc.trim()) {
      setDetailRowError("请填写描述");
      return;
    }
    if (detailAmount === "" || Number.isNaN(amt) || amt === 0) {
      setDetailRowError("请填写有效的加减数量（不能为0）");
      return;
    }
    setEditTransactions((list) => [
      ...list,
      { id: Date.now() + Math.random(), desc: detailDesc.trim(), amount: amt, dest: detailDest },
    ]);
    setDetailDesc("");
    setDetailAmount("");
    setDetailDest("");
    setDetailRowError("");
  }

  function removeDetailRow(id) {
    setEditTransactions((list) => list.filter((t) => t.id !== id));
  }

  async function saveDetailEdit() {
    if (!isAdmin) return;
    if (!showDetail) return;
    const { worker, index } = showDetail;
    const record = data[worker].history[index];
    if (record.exported) return;
    const num = parseFloat(editActual);
    if (editActual === "" || Number.isNaN(num)) {
      setDetailError("请填写有效的实重");
      return;
    }
    if (!editDate) {
      setDetailError("请选择日期");
      return;
    }
    setDetailSaving(true);
    const newHistoryRaw = [...data[worker].history];
    newHistoryRaw[index] = {
      ...newHistoryRaw[index],
      transactions: editTransactions,
      actual: num,
      date: editDate,
    };
    const newHistory = recomputeChain(newHistoryRaw);
    const lastWeight = newHistory.length
      ? newHistory[newHistory.length - 1].actual
      : null;
    const nextWorkerData = { lastWeight, history: newHistory, drafts: data[worker].drafts || {} };
    try {
      await persistWorker(worker, nextWorkerData);
      setData((d) => ({ ...d, [worker]: nextWorkerData }));
      setShowDetail(null);
    } catch {
      setDetailError("保存失败，检查网络后重试");
    } finally {
      setDetailSaving(false);
    }
  }

  // ---- 导出 / 归档 ----
  const pendingCount = useMemo(() => {
    let days = 0;
    let lines = 0;
    for (const w of WORKERS) {
      const hist = data[w]?.history || [];
      for (const r of hist) {
        if (!r.exported) {
          days += 1;
          lines += (r.transactions || []).length;
        }
      }
    }
    return { days, lines };
  }, [data]);

  async function handleExport() {
    setExporting(true);
    setExportMsg("");
    try {
      const summaryRows = [];
      const detailRows = [];
      const keys = new Set();
      for (const w of WORKERS) {
        const hist = data[w]?.history || [];
        hist.forEach((r) => {
          if (r.exported) return;
          keys.add(`${w}__${r.date}`);
          summaryRows.push({
            Worker: w,
            日期: r.date,
            要有: r.expected ?? "",
            实重: r.actual,
            损耗: r.loss ?? "",
          });
          (r.transactions || []).forEach((t) => {
            detailRows.push({
              Worker: w,
              日期: r.date,
              描述: t.desc,
              "加减(g)": t.amount,
              去向: t.dest || "",
            });
          });
        });
      }
      if (summaryRows.length === 0) {
        setExportMsg("没有还没导出过的记录");
        setExporting(false);
        return;
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "每日汇总");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), "流水明细");
      XLSX.writeFile(wb, `金重对账_${todayStr()}.xlsx`);
      setPendingExportKeys(keys);
      setExportMsg(
        `已导出 ${summaryRows.length} 天、${detailRows.length} 条流水。确认文件保存好后，可以点下面按钮清空这批流水明细（汇总数字会保留）。`
      );
    } catch {
      setExportMsg("导出失败，请重试");
    } finally {
      setExporting(false);
    }
  }

  async function handleClearExported() {
    if (!isAdmin) return;
    if (!pendingExportKeys) return;
    setClearing(true);
    try {
      const nextDataLocal = { ...data };
      const toPersist = [];
      for (const w of WORKERS) {
        const hist = data[w]?.history || [];
        let changed = false;
        const newHist = hist.map((r) => {
          if (!r.exported && pendingExportKeys.has(`${w}__${r.date}`)) {
            changed = true;
            return { ...r, exported: true, transactions: [] };
          }
          return r;
        });
        if (changed) {
          const nextWorkerData = { lastWeight: data[w].lastWeight, history: newHist, drafts: data[w].drafts || {} };
          nextDataLocal[w] = nextWorkerData;
          toPersist.push({ worker: w, data: nextWorkerData });
        }
      }
      for (const item of toPersist) {
        await persistWorker(item.worker, item.data);
      }
      setData(nextDataLocal);
      setPendingExportKeys(null);
      setConfirmClear(false);
      setExportMsg("已清空这批流水明细，每日汇总和累计损耗都还保留着。");
    } catch {
      setExportMsg("清空失败，检查网络后重试（已下载的Excel文件不受影响）");
    } finally {
      setClearing(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-[300px] flex items-center justify-center text-stone-400 bg-stone-950 rounded-2xl">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        正在检查登录状态…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="w-full max-w-sm mx-auto bg-stone-950 text-stone-100 rounded-2xl border border-stone-800 p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <Scale className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-stone-100 tracking-wide">
                {t("金重对账", "Gold Ledger")}
              </h1>
              <p className="text-xs text-stone-500">{t("请登录", "Please sign in")}</p>
            </div>
          </div>
          <button
            onClick={toggleLang}
            className="text-xs px-2 py-1 rounded-lg border border-stone-700 text-stone-400 hover:text-stone-200 shrink-0"
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
        </div>
        <form onSubmit={handleLogin}>
          <label className="block text-xs text-stone-500 mb-1">{t("账号", "Account")}</label>
          <input
            type="text"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500 mb-3"
            autoCapitalize="off"
          />
          <label className="block text-xs text-stone-500 mb-1">{t("密码", "Password")}</label>
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500 mb-3"
          />
          {loginError && <p className="text-xs text-rose-400 mb-3">{loginError}</p>}
          <button
            type="submit"
            disabled={loginBusy}
            className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
          >
            {loginBusy && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("登录", "Sign in")}
          </button>
        </form>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="min-h-[300px] flex items-center justify-center text-stone-400 bg-stone-950 rounded-2xl">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        {t("正在加载记录…", "Loading records…")}
      </div>
    );
  }

  const detailRecord = showDetail ? data[showDetail.worker].history[showDetail.index] : null;
  const detailDestinations = showDetail ? destinationsFor(showDetail.worker) : [];
  const detailTotal = editTransactions.reduce((s, t) => s + t.amount, 0);
  const detailActualNum = editActual === "" ? null : parseFloat(editActual);
  const detailPrevWeight = detailRecord ? detailRecord.prevWeight : null;
  const detailExpected =
    detailPrevWeight !== null && detailPrevWeight !== undefined
      ? detailPrevWeight + detailTotal
      : null;
  const detailLoss =
    detailExpected !== null && detailActualNum !== null && !Number.isNaN(detailActualNum)
      ? detailActualNum - detailExpected
      : null;

  return (
    <div className="w-full bg-stone-950 text-stone-100 rounded-2xl border border-stone-800 p-5 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
        <div className="flex items-center justify-between md:justify-start gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <Scale className="w-5 h-5 text-amber-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-stone-100 tracking-wide truncate">
                {t("金重对账", "Gold Ledger")}
              </h1>
              <p className="text-xs text-stone-500 truncate">
                {t("每天过秤，自动算损耗", "Weigh daily, loss calculated automatically")}
              </p>
            </div>
          </div>
          <button
            onClick={toggleLang}
            className="md:hidden shrink-0 text-xs px-2.5 py-1.5 rounded-lg border border-stone-700 text-stone-400 hover:text-stone-200"
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
        </div>
        {loadError && (
          <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-1.5">
            {loadError}
          </div>
        )}
        <div className="flex items-center justify-between md:justify-end gap-3">
          <button
            onClick={toggleLang}
            className="hidden md:inline-flex shrink-0 text-xs px-2.5 py-1.5 rounded-lg border border-stone-700 text-stone-400 hover:text-stone-200"
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
          <span className="text-xs text-stone-500 min-w-0 truncate">
            <span className="truncate">{session.user.email}</span>
            <span
              className={
                "ml-1.5 px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap " +
                (isAdmin
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-stone-800 text-stone-400")
              }
            >
              {isAdmin ? "admin" : "user"}
            </span>
          </span>
          <button
            onClick={handleLogout}
            className="shrink-0 text-xs px-2.5 py-1.5 rounded-lg text-stone-500 hover:text-stone-300 hover:bg-stone-900"
          >
            {t("退出", "Sign out")}
          </button>
        </div>
      </div>

      {!isAdmin && (
        <p className="text-xs text-stone-600 mb-4">
          {t(
            "你是普通账号，只能看到最近3天的记录；导出、撤销、编辑历史等功能只有管理员能用。",
            "You have a standard account: only the last 3 days are visible. Export, undo, and edit-history are admin-only."
          )}
        </p>
      )}

      <div className="flex gap-2 mb-6 overflow-x-auto -mx-5 px-5 md:mx-0 md:px-0 md:flex-wrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[
          { key: "workers", label: t("对账", "Reconcile"), icon: Scale },
          { key: "shipments", label: t("出货记录", "Shipments"), icon: Truck },
          { key: "transfers", label: t("转手核对", "Transfers"), icon: ArrowLeftRight },
          ...(isAdmin ? [{ key: "admin", label: t("账号管理", "Accounts"), icon: Users }] : []),
        ].map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={
              "shrink-0 flex items-center gap-1.5 px-4 py-2.5 md:py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap " +
              (view === v.key
                ? "bg-amber-500 text-stone-950"
                : "bg-stone-900 text-stone-300 hover:bg-stone-800 border border-stone-800")
            }
          >
            <v.icon className="w-4 h-4" />
            {v.label}
          </button>
        ))}
      </div>

      {view === "workers" && (
        <>
      <p className="text-xs text-stone-500 mb-4">
        数据存在Supabase数据库里，团队里打开这个网址的人看到的是同一份记录。
      </p>

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
        <h2 className="text-sm font-medium text-stone-300 mb-1 flex items-center gap-2">
          <Archive className="w-4 h-4" />
          {t("导出与归档（全部worker）", "Export & Archive (all workers)")}
        </h2>
        <p className="text-xs text-stone-500 mb-3">
          {t(
            `还有 ${pendingCount.days} 天、${pendingCount.lines} 条流水未导出。建议每7天导出一次备份。`,
            `${pendingCount.days} day(s), ${pendingCount.lines} line(s) not yet exported. We recommend exporting every 7 days.`
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 bg-stone-800 hover:bg-stone-700 border border-stone-700 disabled:opacity-60 rounded-lg px-4 py-2 text-sm text-stone-100"
          >
            {exporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {t("导出Excel", "Export Excel")}
          </button>
          {pendingExportKeys && (
            <>
              {confirmClear ? (
                <>
                  <span className="text-xs text-rose-400">
                    {t("确定清空这批明细？（汇总数字会保留）", "Clear this batch of line items? (Summary numbers stay)")}
                  </span>
                  <button
                    onClick={handleClearExported}
                    disabled={clearing}
                    className="text-xs px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/40 text-rose-400 disabled:opacity-60"
                  >
                    {clearing ? t("清空中…", "Clearing…") : t("确认清空", "Confirm clear")}
                  </button>
                  <button
                    onClick={() => setConfirmClear(false)}
                    className="text-xs px-3 py-1.5 rounded-lg text-stone-500 hover:text-stone-300"
                  >
                    {t("取消", "Cancel")}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-400 hover:text-stone-200"
                >
                  {t("清空已导出明细", "Clear exported line items")}
                </button>
              )}
            </>
          )}
        </div>
        {exportMsg && <p className="text-xs text-stone-400 mt-2">{exportMsg}</p>}
      </div>

      <div className="flex gap-2 mb-6 border-b border-stone-800 pb-3 overflow-x-auto -mx-5 px-5 md:mx-0 md:px-0 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {WORKERS.map((w) => (
          <button
            key={w}
            onClick={() => setActiveWorker(w)}
            className={
              "shrink-0 px-4 py-2.5 md:py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap " +
              (activeWorker === w
                ? "bg-amber-500 text-stone-950"
                : "bg-stone-900 text-stone-300 hover:bg-stone-800 border border-stone-800")
            }
          >
            {w}
          </button>
        ))}
      </div>

      <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 mb-6">
        <label className="block text-xs text-amber-400/80 mb-1 font-medium">
          {t("正在录入哪一天的数据？", "Which day are you entering?")}
        </label>
        <input
          type="date"
          value={dateInput}
          onChange={(e) => setDateInput(e.target.value)}
          className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
        />
        <p className="text-xs text-stone-500 mt-2">
          {t(
            "下面的流水和实重都会记在这个日期上。补录以前的数据时，请从最早的一天开始，按顺序一天天存完再存下一天。",
            "Flow entries and weight below will be recorded under this date. When backfilling, start from the earliest day and save one day at a time in order."
          )}
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <p className="text-xs text-stone-500 mb-1">{t("上次实重", "Last actual weight")}</p>
          <p className="text-xl font-mono tabular-nums text-stone-100">
            {hasBaseline ? fmtPlain(cur.lastWeight) + " g" : t("尚未设置", "Not set")}
          </p>
        </div>
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <p className="text-xs text-stone-500 mb-1">{t("今日变动合计", "Today's net change")}</p>
          <p
            className={
              "text-xl font-mono tabular-nums " +
              (totalChange > 0
                ? "text-emerald-400"
                : totalChange < 0
                ? "text-rose-400"
                : "text-stone-100")
            }
          >
            {fmt(totalChange)} g
          </p>
        </div>
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <p className="text-xs text-stone-500 mb-1">{t("历史累计损耗", "Cumulative loss")}</p>
          <p
            className={
              "text-xl font-mono tabular-nums " +
              (Math.abs(cumulativeLoss) > LOSS_THRESHOLD * 3
                ? "text-rose-400"
                : "text-stone-100")
            }
          >
            {fmt(cumulativeLoss)} g
          </p>
        </div>
      </div>

      {!hasBaseline && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6 text-sm text-amber-300">
          {t(
            `还没有 ${activeWorker} 的期初实重，先在下面填入这一天过秤的重量作为起点，之后就能自动算损耗了。`,
            `No starting weight for ${activeWorker} yet. Enter today's scale reading below as the baseline, then loss will be calculated automatically from then on.`
          )}
        </div>
      )}

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
        <h2 className="text-sm font-medium text-stone-300 mb-3">
          {dateInput} {t("流水", "flow")}（{activeWorker}）
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_130px_auto] gap-2 mb-2">
          <input
            type="text"
            placeholder={t("描述，例如：出 老板-999料", "Description, e.g. Out - Boss 999")}
            value={descInput}
            onChange={(e) => setDescInput(e.target.value)}
            className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
          />
          <input
            type="number"
            step="0.01"
            placeholder={t("+/- 克", "+/- grams")}
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 font-mono"
          />
          <select
            value={destInput}
            onChange={(e) => setDestInput(e.target.value)}
            className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
          >
            {destinations.map((d) => (
              <option key={d} value={d}>
                {d === "" ? t("去向（可选）", "Destination (optional)") : d}
              </option>
            ))}
          </select>
          <button
            onClick={addRow}
            className="flex items-center justify-center gap-1 bg-stone-800 hover:bg-stone-700 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100"
          >
            <Plus className="w-4 h-4" />
            {t("添加", "Add")}
          </button>
        </div>
        {rowError && <p className="text-xs text-rose-400 mb-2">{rowError}</p>}

        {curDraft.length === 0 ? (
          <p className="text-sm text-stone-600 py-4 text-center">
            {t("这一天还没有记录任何加减", "No entries for this day yet")}
          </p>
        ) : (
          <div className="divide-y divide-stone-800 border-t border-stone-800 mt-2">
            {curDraft.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between py-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-stone-300 truncate">{tx.desc}</span>
                  {tx.dest && (
                    <span className="text-xs text-stone-500 bg-stone-800 rounded px-2 py-0.5 shrink-0">
                      {tx.dest}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={
                      "font-mono tabular-nums " +
                      (tx.amount > 0 ? "text-emerald-400" : "text-rose-400")
                    }
                  >
                    {fmt(tx.amount)} g
                  </span>
                  <button
                    onClick={() => removeRow(tx.id)}
                    aria-label={t("删除这条记录", "Delete this entry")}
                    className="text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
        <h2 className="text-sm font-medium text-stone-300 mb-3">{t("过秤结算", "Scale settlement")}</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="block text-xs text-stone-500 mb-1">
              {t(`过秤读数（${dateInput}，连盒子，克）`, `Scale reading (${dateInput}, with box, g)`)}
            </label>
            <input
              type="number"
              step="0.01"
              placeholder={t("从秤上读到的数字", "Number from the scale")}
              value={actualInput}
              onChange={(e) => setActualInput(e.target.value)}
              className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-lg font-mono tabular-nums text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">{t("盒子重量（克）", "Box weight (g)")}</label>
            {isAdmin ? (
              <div className="flex gap-1.5">
                <input
                  type="number"
                  step="0.01"
                  value={boxWeightDraft}
                  onChange={(e) => setBoxWeightDraft(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-stone-100 focus:outline-none focus:border-amber-500"
                />
                <button
                  onClick={saveBoxWeight}
                  className="shrink-0 text-xs px-3 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100"
                >
                  {t("更新", "Update")}
                </button>
              </div>
            ) : (
              <div className="w-full bg-stone-950 border border-stone-800 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-stone-500">
                {fmtPlain(parseFloat(boxWeightDraft) || 0)}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">
              {t("找回重量（没有就是0，克）", "Recovered weight (0 if none, g)")}
            </label>
            <input
              type="number"
              step="0.01"
              value={recoverInput}
              onChange={(e) => setRecoverInput(e.target.value)}
              className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-stone-100 focus:outline-none focus:border-amber-500"
            />
          </div>
        </div>
        {actualNum !== null && !Number.isNaN(actualNum) && (
          <p className="text-xs text-stone-500 mb-2">
            {t("算入损耗的实重 = 过秤读数 − 盒重 + 找回 =", "Actual weight used = scale reading − box + recovered =")}{" "}
            <span className="text-stone-300 font-mono">{fmtPlain(actualNum)} g</span>
          </p>
        )}
        {actualError && (
          <p className="text-xs text-rose-400 mt-2">{actualError}</p>
        )}

        {hasBaseline && (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
              <p className="text-xs text-stone-500 mb-1">{t("要有", "Expected")}</p>
              <p className="font-mono tabular-nums text-stone-200">
                {fmtPlain(expected)} g
              </p>
            </div>
            <div
              className={
                "border rounded-lg p-3 " +
                (loss === null
                  ? "bg-stone-950 border-stone-800"
                  : lossOver
                  ? "bg-rose-500/10 border-rose-500/40"
                  : "bg-emerald-500/10 border-emerald-500/40")
              }
            >
              <p className="text-xs text-stone-500 mb-1 flex items-center gap-1">
                {t("损耗", "Loss")}
                {loss !== null &&
                  (lossOver ? (
                    <AlertTriangle className="w-3 h-3 text-rose-400" />
                  ) : (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  ))}
              </p>
              <p
                className={
                  "font-mono tabular-nums " +
                  (loss === null
                    ? "text-stone-500"
                    : lossOver
                    ? "text-rose-400"
                    : "text-emerald-400")
                }
              >
                {loss === null ? t("填入实重后显示", "Shown after weight entered") : fmt(loss) + " g"}
              </p>
            </div>
          </div>
        )}

        <button
          onClick={saveDay}
          disabled={saving}
          className="mt-4 w-full md:w-auto flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {t("保存这一天", "Save this day")}
        </button>
        {saveMsg && (
          <p className="text-xs text-stone-400 mt-2">{saveMsg}</p>
        )}
      </div>

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-stone-300 flex items-center gap-2">
            <History className="w-4 h-4" />
            {t(`历史记录（最近 ${recentHistory.length} 天，点日期看详情）`, `History (last ${recentHistory.length} days, click a date for details)`)}
          </h2>
          {cur.history.length > 0 && (
            <div className="flex items-center gap-2">
              {confirmUndo && (
                <span className="text-xs text-rose-400">{t("确定撤销最近一天？", "Undo the most recent day?")}</span>
              )}
              <button
                onClick={() =>
                  confirmUndo ? undoLastDay() : setConfirmUndo(true)
                }
                disabled={undoing}
                className={
                  "text-xs px-3 py-1.5 rounded-lg border disabled:opacity-60 " +
                  (confirmUndo
                    ? "bg-rose-500/10 border-rose-500/40 text-rose-400"
                    : "bg-stone-800 border-stone-700 text-stone-400 hover:text-stone-200")
                }
              >
                {undoing
                  ? t("撤销中…", "Undoing…")
                  : confirmUndo
                  ? t("确认撤销", "Confirm undo")
                  : t("撤销最近一天", "Undo last day")}
              </button>
              {confirmUndo && (
                <button
                  onClick={() => setConfirmUndo(false)}
                  className="text-xs px-3 py-1.5 rounded-lg text-stone-500 hover:text-stone-300"
                >
                  {t("取消", "Cancel")}
                </button>
              )}
            </div>
          )}
        </div>
        {recentHistory.length === 0 ? (
          <p className="text-sm text-stone-600 py-4 text-center">
            {t("还没有历史记录", "No history yet")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-stone-500 border-b border-stone-800">
                  <th className="text-left py-2 font-normal">{t("日期", "Date")}</th>
                  <th className="text-right py-2 font-normal">{t("要有", "Expected")}</th>
                  <th className="text-right py-2 font-normal">{t("实重", "Actual")}</th>
                  <th className="text-right py-2 font-normal">{t("损耗", "Loss")}</th>
                  <th className="text-right py-2 font-normal">{t("趋势", "Trend")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800">
                {recentHistory.map((r) => {
                  const over =
                    r.loss !== null && Math.abs(r.loss) > LOSS_THRESHOLD;
                  return (
                    <tr key={r._idx} className="hover:bg-stone-950/50">
                      <td
                        className="py-2 text-amber-400 hover:text-amber-300 cursor-pointer underline decoration-dotted"
                        onClick={() => openDetail(activeWorker, r._idx)}
                      >
                        <span className="flex items-center gap-1">
                          {r.date}
                          {r.exported && (
                            <Lock className="w-3 h-3 text-stone-600" />
                          )}
                        </span>
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                        {r.expected === null ? "-" : fmtPlain(r.expected)}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums text-stone-100">
                        {fmtPlain(r.actual)}
                      </td>
                      <td
                        className={
                          "py-2 text-right font-mono tabular-nums " +
                          (r.loss === null
                            ? "text-stone-600"
                            : over
                            ? "text-rose-400"
                            : "text-emerald-400")
                        }
                      >
                        {r.loss === null ? "-" : fmt(r.loss)}
                      </td>
                      <td className="py-2 text-right">
                        {r.loss === null ? (
                          "-"
                        ) : r.loss > 0 ? (
                          <TrendingUp className="w-4 h-4 text-emerald-400 inline" />
                        ) : r.loss < 0 ? (
                          <TrendingDown className="w-4 h-4 text-rose-400 inline" />
                        ) : (
                          <span className="text-stone-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showDetail && detailRecord && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
          onClick={closeDetail}
        >
          <div
            className="bg-stone-900 border border-stone-700 rounded-2xl p-5 md:p-6 max-w-lg w-full max-h-[88vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-stone-200">
                {showDetail.worker} · {detailRecord.date}
              </h3>
              <button
                onClick={closeDetail}
                className="text-stone-500 hover:text-stone-300 p-2 -m-2 rounded-lg active:bg-stone-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {detailRecord.exported ? (
              <div>
                <div className="flex items-center gap-2 text-xs text-stone-500 bg-stone-800 rounded-lg px-3 py-2 mb-4">
                  <Lock className="w-3.5 h-3.5" />
                  {t(
                    "这天的流水明细已经导出并清空，只能查看汇总，无法再编辑。",
                    "This day's line items have been exported and cleared. View-only; can't be edited."
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">{t("要有", "Expected")}</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {fmtPlain(detailRecord.expected)} g
                    </p>
                  </div>
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">{t("实重", "Actual")}</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {fmtPlain(detailRecord.actual)} g
                    </p>
                  </div>
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">{t("损耗", "Loss")}</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {fmt(detailRecord.loss)} g
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-1 md:grid-cols-[1fr_100px_110px_auto] gap-2 mb-2">
                  <input
                    type="text"
                    placeholder={t("描述", "Description")}
                    value={detailDesc}
                    onChange={(e) => setDetailDesc(e.target.value)}
                    className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
                  />
                  <input
                    type="number"
                    step="0.01"
                    placeholder={t("+/- 克", "+/- g")}
                    value={detailAmount}
                    onChange={(e) => setDetailAmount(e.target.value)}
                    className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 font-mono"
                  />
                  <select
                    value={detailDest}
                    onChange={(e) => setDetailDest(e.target.value)}
                    className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                  >
                    {detailDestinations.map((d) => (
                      <option key={d} value={d}>
                        {d === "" ? t("去向", "Destination") : d}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={addDetailRow}
                    className="flex items-center justify-center gap-1 bg-stone-800 hover:bg-stone-700 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {detailRowError && (
                  <p className="text-xs text-rose-400 mb-2">{detailRowError}</p>
                )}

                {editTransactions.length === 0 ? (
                  <p className="text-sm text-stone-600 py-3 text-center">
                    {t("这一天没有流水记录", "No entries for this day")}
                  </p>
                ) : (
                  <div className="divide-y divide-stone-800 border-t border-stone-800 mb-4">
                    {editTransactions.map((t2) => (
                      <div
                        key={t2.id}
                        className="flex items-center justify-between py-2 text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-stone-300 truncate">{t2.desc}</span>
                          {t2.dest && (
                            <span className="text-xs text-stone-500 bg-stone-800 rounded px-2 py-0.5 shrink-0">
                              {t2.dest}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span
                            className={
                              "font-mono tabular-nums " +
                              (t2.amount > 0 ? "text-emerald-400" : "text-rose-400")
                            }
                          >
                            {fmt(t2.amount)} g
                          </span>
                          <button
                            onClick={() => removeDetailRow(t2.id)}
                            className="text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("日期", "Date")}</label>
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">
                      {t("实重（克）", "Actual (g)")}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={editActual}
                      onChange={(e) => setEditActual(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-lg font-mono tabular-nums text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">{t("要有（预览）", "Expected (preview)")}</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {detailExpected === null ? "-" : fmtPlain(detailExpected)} g
                    </p>
                  </div>
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">{t("损耗（预览）", "Loss (preview)")}</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {detailLoss === null ? "-" : fmt(detailLoss)} g
                    </p>
                  </div>
                </div>

                <p className="text-xs text-stone-600 mb-3">
                  {t(
                    '保存后会自动重新计算这天之后每一天的"要有"和"损耗"。',
                    "Saving will automatically recompute expected and loss for every day after this one."
                  )}
                </p>

                {detailError && (
                  <p className="text-xs text-rose-400 mb-2">{detailError}</p>
                )}
                <button
                  onClick={saveDetailEdit}
                  disabled={detailSaving}
                  className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
                >
                  {detailSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  {t("保存修改", "Save changes")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      </>
      )}

      {view === "shipments" && (
        <>
          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              {t(`第一步：登记出货（${SHIP_TO} 待确认）`, `Step 1: Log a shipment (${SHIP_TO} to confirm)`)}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">{t("送出方", "From")}</label>
                <select
                  value={shipFrom}
                  onChange={(e) => setShipFrom(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                >
                  {SHIP_WORKERS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">{t("出货日期", "Shipment date")}</label>
                <input
                  type="date"
                  value={shipDate}
                  onChange={(e) => setShipDate(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              {t("其他类别出货（戒指 / 链 / 牌 / 自定义）", "Other categories (rings / chains / plates / custom)")}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-[130px_1fr_120px_auto] gap-2 mb-2">
              <select
                value={shipCategory}
                onChange={(e) => setShipCategory(e.target.value)}
                className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
              >
                {SHIP_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c === "OTHER" ? t("自定义…", "Custom…") : c}
                  </option>
                ))}
              </select>
              {shipCategory === "OTHER" && (
                <input
                  type="text"
                  placeholder={t("类别名称", "Category name")}
                  value={shipCategoryCustom}
                  onChange={(e) => setShipCategoryCustom(e.target.value)}
                  className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
                />
              )}
              <input
                type="number"
                step="0.01"
                placeholder={t("重量(g)", "Weight (g)")}
                value={shipWeight}
                onChange={(e) => setShipWeight(e.target.value)}
                className={
                  "bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 font-mono " +
                  (shipCategory === "OTHER" ? "" : "md:col-start-2")
                }
              />
              <button
                onClick={addShipItem}
                className="flex items-center justify-center gap-1 bg-stone-800 hover:bg-stone-700 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100"
              >
                <Plus className="w-4 h-4" />
                {t("添加", "Add")}
              </button>
            </div>
            {shipRowError && (
              <p className="text-xs text-rose-400 mb-2">{shipRowError}</p>
            )}
            {shipItems.length > 0 && (
              <div className="divide-y divide-stone-800 border-t border-stone-800 mt-2">
                {shipItems.map((it) => (
                  <div
                    key={it.id}
                    className="flex items-center justify-between py-2 text-sm"
                  >
                    <span className="text-stone-300">{it.category}</span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono tabular-nums text-stone-100">
                        {fmtPlain(it.weight)} g
                      </span>
                      <button
                        onClick={() => removeShipItem(it.id)}
                        className="text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {[
            {
              label: "GOLDBAR",
              qty: goldbarQty,
              setQty: setGoldbarQty,
              actual: goldbarActual,
              setActual: setGoldbarActual,
              state: goldbarState,
              confirmed: goldbarConfirmed,
              setConfirmed: setGoldbarConfirmed,
            },
            {
              label: "GOLDBEAN",
              qty: goldbeanQty,
              setQty: setGoldbeanQty,
              actual: goldbeanActual,
              setActual: setGoldbeanActual,
              state: goldbeanState,
              confirmed: goldbeanConfirmed,
              setConfirmed: setGoldbeanConfirmed,
            },
          ].map((g) => (
            <div
              key={g.label}
              className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6"
            >
              <h2 className="text-sm font-medium text-stone-300 mb-3">
                {g.label} {t("出货数量", "shipped quantity")}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-stone-500 border-b border-stone-800">
                      <th className="text-left py-2 font-normal">{t("面额", "Denomination")}</th>
                      <th className="text-right py-2 font-normal w-28">{t("数量", "Qty")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800">
                    {DENOMINATIONS.map((d) => (
                      <tr key={d.key}>
                        <td className="py-1.5 text-stone-400">{d.label}</td>
                        <td className="py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={g.qty[d.key] || ""}
                            onChange={(e) =>
                              g.setQty((q) => ({ ...q, [d.key]: e.target.value }))
                            }
                            className="w-full bg-stone-950 border border-stone-700 rounded-lg px-2 py-1 text-sm text-right text-stone-100 font-mono focus:outline-none focus:border-amber-500"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                  <p className="text-xs text-stone-500 mb-1">{t("按面额计算小计", "Subtotal by denomination")}</p>
                  <p className="font-mono tabular-nums text-stone-200">
                    {fmtPlain(g.state.calc)} g
                  </p>
                </div>
                <div>
                  <label className="block text-xs text-stone-500 mb-1">
                    {t("实重（过秤读数，可选）", "Actual (scale reading, optional)")}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={g.actual}
                    onChange={(e) => g.setActual(e.target.value)}
                    className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>
              {g.state.diff !== null && (
                <div
                  className={
                    "mt-3 rounded-lg p-3 border " +
                    (g.state.overTolerance
                      ? "bg-rose-500/10 border-rose-500/40"
                      : "bg-emerald-500/10 border-emerald-500/40")
                  }
                >
                  <p
                    className={
                      "text-sm font-mono tabular-nums flex items-center gap-1 " +
                      (g.state.overTolerance ? "text-rose-400" : "text-emerald-400")
                    }
                  >
                    {g.state.overTolerance && <AlertTriangle className="w-3.5 h-3.5" />}
                    {t("实重跟小计差", "Actual differs from subtotal by")} {fmt(g.state.diff)} g
                  </p>
                  {g.state.overTolerance && !g.confirmed && (
                    <button
                      onClick={() => g.setConfirmed(true)}
                      className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/40 text-rose-400"
                    >
                      {t("差异较大，确认使用这个实重", "Large difference — confirm to use this weight")}
                    </button>
                  )}
                  {g.state.overTolerance && g.confirmed && (
                    <p className="text-xs text-stone-500 mt-1">{t("已确认，可以保存", "Confirmed, ready to save")}</p>
                  )}
                </div>
              )}
              <p className="text-xs text-stone-600 mt-2">
                {t(
                  `1 DINAR 按 4.25g、1/2 DINAR 按 2.125g 计算；实重跟小计差超过${DENOM_TOLERANCE}g会标红，需要点确认才能保存。`,
                  `1 DINAR = 4.25g, 1/2 DINAR = 2.125g. A difference over ${DENOM_TOLERANCE}g between actual and subtotal is flagged and needs confirmation before saving.`
                )}
              </p>
            </div>
          ))}

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <label className="block text-xs text-stone-500 mb-1">
              {t(`${shipFrom} 流水描述（会自动写进当天流水，可以改）`, `${shipFrom} flow description (auto-written to today's flow, editable)`)}
            </label>
            <input
              type="text"
              value={shipFlowDesc}
              onChange={(e) => setShipFlowDesc(e.target.value)}
              className="w-full md:w-96 bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
            />
            <p className="text-xs text-stone-600 mt-2">
              {t(
                `保存时会自动在描述后面加上类别，并写入 ${shipFrom} 当天流水（减），去向标为 ${SHIP_TO}。单号由 ${SHIP_TO} 确认接收时填写。`,
                `On save, the category is appended to the description automatically and written to ${shipFrom}'s flow for today (minus), tagged to ${SHIP_TO}. The serial number is filled in by ${SHIP_TO} when confirming receipt.`
              )}
            </p>
          </div>

          <button
            onClick={saveShipment}
            disabled={shipSaving}
            className="mb-2 w-full md:w-auto flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
          >
            {shipSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {t("保存这次出货", "Save this shipment")}
          </button>
          {shipMsg && <p className="text-xs text-stone-400 mb-6">{shipMsg}</p>}

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              {t(`待确认（${pendingShipments.length}）`, `Pending (${pendingShipments.length})`)}
            </h2>
            {pendingShipments.length === 0 ? (
              <p className="text-sm text-stone-600 py-4 text-center">
                {t("没有等待确认的出货", "No shipments pending confirmation")}
              </p>
            ) : (
              <div className="space-y-3">
                {pendingShipments.map((r) => (
                  <div
                    key={r.id}
                    className="bg-stone-950 border border-stone-800 rounded-lg p-3"
                  >
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="text-sm text-stone-300">
                        <span className="text-stone-600 italic">
                          {t(`单号待${SHIP_TO}填写`, `Serial pending from ${SHIP_TO}`)}
                        </span>
                        {"  "}
                        {r.fromWorker} → {r.toWorker}
                        <span className="text-stone-500 ml-2">{r.date}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-stone-100 text-sm">
                          {fmtPlain(r.sentTotal)} g
                        </span>
                        <button
                          onClick={() => deleteShipmentRecord(r)}
                          className="text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-stone-600 mt-1">{itemsSummary(r.items)}</p>

                    {shipConfirmingId === r.id ? (
                      <div className="mt-3 pt-3 border-t border-stone-800">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2">
                          <div>
                            <label className="block text-xs text-stone-500 mb-1">
                              {t("确认日期", "Confirm date")}
                            </label>
                            <input
                              type="date"
                              value={shipConfirmDate}
                              onChange={(e) => setShipConfirmDate(e.target.value)}
                              className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-stone-500 mb-1">
                              {SHIP_TO} {t("重量(g)", "weight (g)")}
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              value={shipConfirmWeight}
                              onChange={(e) => setShipConfirmWeight(e.target.value)}
                              className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-stone-500 mb-1">
                              {t("单号", "Serial no.")}
                            </label>
                            <input
                              type="text"
                              placeholder={t("例如 HQ2608081", "e.g. HQ2608081")}
                              value={shipConfirmSerial}
                              onChange={(e) => setShipConfirmSerial(e.target.value)}
                              className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
                            />
                          </div>
                        </div>
                        {shipConfirmWeight !== "" &&
                          !Number.isNaN(parseFloat(shipConfirmWeight)) && (
                            <p className="text-xs text-stone-500 mb-2">
                              {t("差异预览：", "Diff preview:")}
                              <span
                                className={
                                  Math.abs(parseFloat(shipConfirmWeight) - r.sentTotal) >
                                  (shipmentData.threshold ?? 0.05)
                                    ? "text-rose-400"
                                    : "text-emerald-400"
                                }
                              >
                                {" "}
                                {fmt(parseFloat(shipConfirmWeight) - r.sentTotal)} g
                              </span>
                            </p>
                          )}
                        {shipConfirmError && (
                          <p className="text-xs text-rose-400 mb-2">{shipConfirmError}</p>
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={confirmShipment}
                            disabled={shipConfirmSaving}
                            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-4 py-2 text-sm"
                          >
                            {shipConfirmSaving ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-4 h-4" />
                            )}
                            {t("确认接收", "Confirm receipt")}
                          </button>
                          <button
                            onClick={() => setShipConfirmingId(null)}
                            className="text-xs px-3 py-2 rounded-lg text-stone-500 hover:text-stone-300"
                          >
                            {t("取消", "Cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => openShipConfirm(r)}
                        className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100"
                      >
                        {SHIP_TO} {t("确认接收", "confirm receipt")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <label className="block text-xs text-stone-500 mb-1">
              {t("误差标红阈值（超过这个数就标红，克）", "Diff alert threshold (flagged above this, g)")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                value={shipThresholdDraft}
                onChange={(e) => setShipThresholdDraft(e.target.value)}
                className="w-32 bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
              />
              <button
                onClick={saveShipThreshold}
                className="text-xs px-3 py-2 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100"
              >
                {t("更新阈值", "Update threshold")}
              </button>
              <span className="text-xs text-stone-600">
                {t("当前生效：", "Currently:")} {fmtPlain(shipmentData.threshold ?? 0.05)} g
              </span>
            </div>
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
            <h2 className="text-sm font-medium text-stone-300 mb-3 flex items-center gap-2">
              <Truck className="w-4 h-4" />
              {t(`已确认（${confirmedShipments.length}）`, `Confirmed (${confirmedShipments.length})`)}
            </h2>
            {confirmedShipments.length === 0 ? (
              <p className="text-sm text-stone-600 py-4 text-center">
                {t("还没有已确认的出货", "No confirmed shipments yet")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-stone-500 border-b border-stone-800">
                      <th className="text-left py-2 font-normal">{t("单号", "Serial")}</th>
                      <th className="text-left py-2 font-normal">{t("送出方", "From")}</th>
                      <th className="text-left py-2 font-normal">{t("明细", "Details")}</th>
                      <th className="text-right py-2 font-normal">{t("送出", "Sent")}</th>
                      <th className="text-right py-2 font-normal">{SHIP_TO}</th>
                      <th className="text-right py-2 font-normal">{t("差异", "Diff")}</th>
                      <th className="text-right py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800">
                    {confirmedShipments.map((r) => {
                      const over = Math.abs(r.diff) > (shipmentData.threshold ?? 0.05);
                      return (
                        <tr key={r.id}>
                          <td className="py-2 text-stone-300">{r.serial}</td>
                          <td className="py-2 text-stone-400">
                            {r.fromWorker}
                            <div className="text-xs text-stone-600">
                              {r.date} → {r.confirmDate}
                            </div>
                          </td>
                          <td className="py-2 text-stone-500 text-xs">
                            {itemsSummary(r.items)}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                            {fmtPlain(r.sentTotal)}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                            {fmtPlain(r.confirmWeight)}
                          </td>
                          <td
                            className={
                              "py-2 text-right font-mono tabular-nums " +
                              (over ? "text-rose-400" : "text-emerald-400")
                            }
                          >
                            <span className="inline-flex items-center gap-1">
                              {over && <AlertTriangle className="w-3 h-3" />}
                              {fmt(r.diff)}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => deleteShipmentRecord(r)}
                              className="text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}


      {view === "transfers" && (
        <>
          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <button
              onClick={() => setShowQuickTransfer((v) => !v)}
              className="text-xs px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100"
            >
              {showQuickTransfer
                ? t("收起一次性登记", "Hide quick entry")
                : t("一次性登记（送出+接收一起填）", "Quick entry (fill send + receive together)")}
            </button>
            {showQuickTransfer && (
              <div className="mt-4">
                <p className="text-xs text-stone-500 mb-3">
                  {t(
                    '适合送出方已经把重量都告诉接收方、想一次填完两边的情况。保存后直接是"已确认"状态，两边的流水会同时写进去。',
                    'For when the sender already told the receiver the weight and you want to fill both sides at once. Saves directly as "confirmed" and writes both flows at the same time.'
                  )}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("类型", "Type")}</label>
                    <select
                      value={quickType}
                      onChange={(e) => setQuickType(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    >
                      {TRANSFER_TYPE_PRESETS.map((tp) => (
                        <option key={tp} value={tp}>
                          {tp}
                        </option>
                      ))}
                      <option value="OTHER">{t("自定义…", "Custom…")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("送出方", "From")}</label>
                    <select
                      value={quickFrom}
                      onChange={(e) => setQuickFrom(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    >
                      {WORKERS.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("接收方", "To")}</label>
                    <select
                      value={quickTo}
                      onChange={(e) => setQuickTo(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    >
                      {WORKERS.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {quickType === "OTHER" && (
                  <input
                    type="text"
                    placeholder={t("自定义类型名称", "Custom type name")}
                    value={quickTypeCustom}
                    onChange={(e) => setQuickTypeCustom(e.target.value)}
                    className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 mb-3"
                  />
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3 pb-3 border-b border-stone-800">
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("送出日期", "Sent date")}</label>
                    <input
                      type="date"
                      value={quickSentDate}
                      onChange={(e) => setQuickSentDate(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("送出方重量(g)", "Sent weight (g)")}</label>
                    <input
                      type="number"
                      step="0.01"
                      value={quickSentWeight}
                      onChange={(e) => setQuickSentWeight(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">
                      {quickFrom} {t("流水描述", "flow description")}
                    </label>
                    <input
                      type="text"
                      value={quickSentDesc}
                      onChange={(e) => setQuickSentDesc(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("接收日期", "Received date")}</label>
                    <input
                      type="date"
                      value={quickReceivedDate}
                      onChange={(e) => setQuickReceivedDate(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">{t("接收方重量(g)", "Received weight (g)")}</label>
                    <input
                      type="number"
                      step="0.01"
                      value={quickReceivedWeight}
                      onChange={(e) => setQuickReceivedWeight(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">
                      {quickTo} {t("流水描述", "flow description")}
                    </label>
                    <input
                      type="text"
                      value={quickReceivedDesc}
                      onChange={(e) => setQuickReceivedDesc(e.target.value)}
                      className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                {quickSentWeight !== "" &&
                  quickReceivedWeight !== "" &&
                  !Number.isNaN(parseFloat(quickSentWeight)) &&
                  !Number.isNaN(parseFloat(quickReceivedWeight)) && (
                    <p className="text-xs text-stone-500 mb-2">
                      {t("差异预览：", "Diff preview:")}
                      <span
                        className={
                          Math.abs(parseFloat(quickReceivedWeight) - parseFloat(quickSentWeight)) >
                          (transferData.threshold ?? 0.05)
                            ? "text-rose-400"
                            : "text-emerald-400"
                        }
                      >
                        {" "}
                        {fmt(parseFloat(quickReceivedWeight) - parseFloat(quickSentWeight))} g
                      </span>
                    </p>
                  )}
                {quickError && <p className="text-xs text-rose-400 mb-2">{quickError}</p>}
                <button
                  onClick={saveQuickTransfer}
                  disabled={quickSaving}
                  className="flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
                >
                  {quickSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  {t("一次性保存（送出+接收）", "Save at once (send + receive)")}
                </button>
                {quickMsg && <p className="text-xs text-stone-400 mt-2">{quickMsg}</p>}
              </div>
            )}
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              {t("第一步：送出方先保存重量", "Step 1: Sender saves weight first")}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">{t("类型", "Type")}</label>
                <select
                  value={transType}
                  onChange={(e) => setTransType(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                >
                  {TRANSFER_TYPE_PRESETS.map((tp) => (
                    <option key={tp} value={tp}>
                      {tp}
                    </option>
                  ))}
                  <option value="OTHER">{t("自定义…", "Custom…")}</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">{t("送出方", "From")}</label>
                <select
                  value={transFrom}
                  onChange={(e) => setTransFrom(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                >
                  {WORKERS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">{t("接收方", "To")}</label>
                <select
                  value={transTo}
                  onChange={(e) => setTransTo(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                >
                  {WORKERS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {transType === "OTHER" && (
              <input
                type="text"
                placeholder={t("自定义类型名称", "Custom type name")}
                value={transTypeCustom}
                onChange={(e) => setTransTypeCustom(e.target.value)}
                className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 mb-3"
              />
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">{t("送出日期", "Sent date")}</label>
                <input
                  type="date"
                  value={transSentDate}
                  onChange={(e) => setTransSentDate(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">{t("送出方重量(g)", "Sent weight (g)")}</label>
                <input
                  type="number"
                  step="0.01"
                  value={transSentWeight}
                  onChange={(e) => setTransSentWeight(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">
                  {t(`${transFrom} 流水描述（会自动写进当天流水，可以改）`, `${transFrom} flow description (auto-written today, editable)`)}
                </label>
                <input
                  type="text"
                  value={transSentDesc}
                  onChange={(e) => setTransSentDesc(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>
            {transError && <p className="text-xs text-rose-400 mb-2">{transError}</p>}
            <button
              onClick={saveSentHalf}
              disabled={transSaving}
              className="flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
            >
              {transSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {t("保存送出方重量（半保存）", "Save sender weight (partial save)")}
            </button>
            {transMsg && <p className="text-xs text-stone-400 mt-2">{transMsg}</p>}
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              {t(`待确认（${pendingTransfers.length}）`, `Pending (${pendingTransfers.length})`)}
            </h2>
            {pendingTransfers.length === 0 ? (
              <p className="text-sm text-stone-600 py-4 text-center">
                {t("没有等待确认的记录", "No records pending confirmation")}
              </p>
            ) : (
              <div className="space-y-3">
                {pendingTransfers.map((r) => (
                  <div
                    key={r.id}
                    className="bg-stone-950 border border-stone-800 rounded-lg p-3"
                  >
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="text-sm text-stone-300">
                        <span className="text-amber-400">{r.type}</span>
                        {"  "}
                        {r.fromWorker} → {r.toWorker}
                        <span className="text-stone-500 ml-2">{r.sentDate}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-stone-100 text-sm">
                          {fmtPlain(r.sentWeight)} g
                        </span>
                        <button
                          onClick={() => deleteTransferRecord(r)}
                          className="text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-stone-600 mt-1">
                      {t("送出方流水：", "Sender flow:")}{r.sentDesc}
                    </p>

                    {confirmingId === r.id ? (
                      <div className="mt-3 pt-3 border-t border-stone-800">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2">
                          <div>
                            <label className="block text-xs text-stone-500 mb-1">
                              {t("接收日期", "Received date")}
                            </label>
                            <input
                              type="date"
                              value={confirmDate}
                              onChange={(e) => setConfirmDate(e.target.value)}
                              className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-stone-500 mb-1">
                              {t("接收方重量(g)", "Received weight (g)")}
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              value={confirmWeight}
                              onChange={(e) => setConfirmWeight(e.target.value)}
                              className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-stone-500 mb-1">
                              {r.toWorker} {t("流水描述", "flow description")}
                            </label>
                            <input
                              type="text"
                              value={confirmDesc}
                              onChange={(e) => setConfirmDesc(e.target.value)}
                              className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                            />
                          </div>
                        </div>
                        {confirmWeight !== "" && !Number.isNaN(parseFloat(confirmWeight)) && (
                          <p className="text-xs text-stone-500 mb-2">
                            {t("差异预览：", "Diff preview:")}
                            <span
                              className={
                                Math.abs(parseFloat(confirmWeight) - r.sentWeight) >
                                (transferData.threshold ?? 0.05)
                                  ? "text-rose-400"
                                  : "text-emerald-400"
                              }
                            >
                              {" "}
                              {fmt(parseFloat(confirmWeight) - r.sentWeight)} g
                            </span>
                          </p>
                        )}
                        {confirmError && (
                          <p className="text-xs text-rose-400 mb-2">{confirmError}</p>
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={confirmReceived}
                            disabled={confirmSaving}
                            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-4 py-2 text-sm"
                          >
                            {confirmSaving ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-4 h-4" />
                            )}
                            {t("确认接收", "Confirm receipt")}
                          </button>
                          <button
                            onClick={() => setConfirmingId(null)}
                            className="text-xs px-3 py-2 rounded-lg text-stone-500 hover:text-stone-300"
                          >
                            {t("取消", "Cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => openConfirm(r)}
                        className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100"
                      >
                        {r.toWorker} {t("确认接收", "confirm receipt")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <label className="block text-xs text-stone-500 mb-1">
              {t("误差标红阈值（超过这个数就标红，克）", "Diff alert threshold (flagged above this, g)")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                value={thresholdDraft}
                onChange={(e) => setThresholdDraft(e.target.value)}
                className="w-32 bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
              />
              <button
                onClick={saveThreshold}
                className="text-xs px-3 py-2 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100"
              >
                {t("更新阈值", "Update threshold")}
              </button>
              <span className="text-xs text-stone-600">
                {t("当前生效：", "Currently:")} {fmtPlain(transferData.threshold ?? 0.05)} g
              </span>
            </div>
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
            <h2 className="text-sm font-medium text-stone-300 mb-3 flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4" />
              {t(`已确认（${confirmedTransfers.length}）`, `Confirmed (${confirmedTransfers.length})`)}
            </h2>
            {confirmedTransfers.length === 0 ? (
              <p className="text-sm text-stone-600 py-4 text-center">
                {t("还没有已确认的记录", "No confirmed records yet")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-stone-500 border-b border-stone-800">
                      <th className="text-left py-2 font-normal">{t("类型", "Type")}</th>
                      <th className="text-left py-2 font-normal">{t("送出→接收", "From → To")}</th>
                      <th className="text-right py-2 font-normal">{t("送出", "Sent")}</th>
                      <th className="text-right py-2 font-normal">{t("接收", "Received")}</th>
                      <th className="text-right py-2 font-normal">{t("差异", "Diff")}</th>
                      <th className="text-right py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800">
                    {confirmedTransfers.map((r) => {
                      const over = Math.abs(r.diff) > (transferData.threshold ?? 0.05);
                      return (
                        <tr key={r.id}>
                          <td className="py-2 text-stone-300">{r.type}</td>
                          <td className="py-2 text-stone-400">
                            {r.fromWorker} → {r.toWorker}
                            <div className="text-xs text-stone-600">
                              {r.sentDate} → {r.receivedDate}
                            </div>
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                            {fmtPlain(r.sentWeight)}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                            {fmtPlain(r.receivedWeight)}
                          </td>
                          <td
                            className={
                              "py-2 text-right font-mono tabular-nums " +
                              (over ? "text-rose-400" : "text-emerald-400")
                            }
                          >
                            <span className="inline-flex items-center gap-1">
                              {over && <AlertTriangle className="w-3 h-3" />}
                              {fmt(r.diff)}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => deleteTransferRecord(r)}
                              className="text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {view === "admin" && isAdmin && (
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-stone-300 flex items-center gap-2">
              <Users className="w-4 h-4" />
              {t(`账号管理（${adminUsers.length}）`, `Accounts (${adminUsers.length})`)}
            </h2>
            <button
              onClick={loadAdminUsers}
              disabled={adminUsersLoading}
              className="text-xs px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-400 hover:text-stone-200 disabled:opacity-60"
            >
              {adminUsersLoading ? t("刷新中…", "Refreshing…") : t("刷新", "Refresh")}
            </button>
          </div>
          {adminUsersError && (
            <p className="text-xs text-rose-400 mb-3">{adminUsersError}</p>
          )}
          {adminUsers.length === 0 ? (
            <p className="text-sm text-stone-600 py-4 text-center">
              {adminUsersLoading ? t("加载中…", "Loading…") : t("还没有账号", "No accounts yet")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-stone-500 border-b border-stone-800">
                    <th className="text-left py-2 font-normal">{t("账号", "Account")}</th>
                    <th className="text-left py-2 font-normal">{t("角色", "Role")}</th>
                    <th className="text-left py-2 font-normal">{t("建立时间", "Created")}</th>
                    <th className="text-right py-2 font-normal"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-800">
                  {adminUsers.map((u) => (
                    <tr key={u.id}>
                      <td className="py-2 text-stone-300">{u.email}</td>
                      <td className="py-2">
                        <span
                          className={
                            "px-1.5 py-0.5 rounded text-[10px] " +
                            (u.role === "admin"
                              ? "bg-amber-500/20 text-amber-400"
                              : "bg-stone-800 text-stone-400")
                          }
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-2 text-stone-500 text-xs">
                        {(u.created_at || "").slice(0, 10)}
                      </td>
                      <td className="py-2 text-right">
                        {u.id !== session.user.id && (
                          <button
                            onClick={() => deleteUser(u.id)}
                            disabled={deletingUserId === u.id}
                            className="text-stone-600 hover:text-rose-400 disabled:opacity-50 p-2 -m-2 rounded-lg active:bg-stone-800"
                          >
                            {deletingUserId === u.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-stone-600 mt-3">
            {t(
              "新建账号请去 Supabase 后台 Authentication → Users → Add user。删除需要先部署好 Edge Function（见下方说明）。",
              "To create an account, go to Supabase → Authentication → Users → Add user. Deletion requires the Edge Function to be deployed first (see instructions)."
            )}
          </p>
        </div>
      )}
    </div>
  );
}
