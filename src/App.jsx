import { useState, useEffect, useMemo, useRef, Fragment } from "react";
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient.js";
import TransferIssues from "./TransferIssues.jsx";
import { todayInMalaysia, shiftDay, WriteGate } from "./ledgerSafety.js";
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
  LayoutDashboard,
} from "lucide-react";

const WORKERS = ["JJ", "PD Lv2", "PD Lv1", "倒模", "Lv1车花", "Lv1倒模"];
const SUMMARY_WORKERS = ["JJ", "PD Lv1", "PD Lv2", "Lv1车花"];
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
const DENOMINATIONS_GOLDBAR = [
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
const DENOMINATIONS_GOLDBEAN = [
  { key: "0.10", label: "0.10", grams: 0.1 },
  { key: "0.20", label: "0.20", grams: 0.2 },
  { key: "0.50", label: "0.50", grams: 0.5 },
  { key: "1.00", label: "1.00", grams: 1.0 },
  { key: "1.50", label: "1.50", grams: 1.5 },
  { key: "2.00", label: "2.00", grams: 2.0 },
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

function calcDenomState(qty, actualStr, denomList) {
  const calc = denomTotal(qty, denomList);
  const actual = actualStr === "" ? null : parseFloat(actualStr);
  const diff = actual !== null && !Number.isNaN(actual) ? actual - calc : null;
  const overTolerance = diff !== null && Math.abs(diff) > DENOM_TOLERANCE;
  const finalWeight = actual !== null && !Number.isNaN(actual) ? actual : calc;
  return { calc, actual, diff, overTolerance, finalWeight };
}
const emptyTransferData = () => ({ threshold: 0.05, history: [] });

function denomTotal(qtyObj, denomList) {
  return denomList.reduce(
    (s, d) => s + (parseFloat(qtyObj[d.key] || 0) || 0) * d.grams,
    0
  );
}

// 生成"面额g×数量"的明细字符串，例如 "5.00g×2、10.00g×1"
function denomBreakdown(qtyObj, denomList) {
  return denomList
    .filter((d) => parseFloat(qtyObj[d.key] || 0) > 0)
    .map((d) => `${d.label}g×${qtyObj[d.key]}`)
    .join("、");
}

function todayStr() {
  return todayInMalaysia();
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
  // 多人同时使用时的同步保护：后台自动刷新不能和本地刚做的改动打架
  const writeGate = useRef(new WriteGate());
  const [syncPending, setSyncPending] = useState(0);
  const [lastSynced, setLastSynced] = useState(null);
  const [workerScope, setWorkerScope] = useState([]);
  const pendingSyncRef = useRef(0); // 还在往服务器同步的暂存流水数
  const mutationRef = useRef(0); // 本地暂存流水的改动计数
  const lastAutoRefreshRef = useRef(0);
  const loadAllDataRef = useRef(null);
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
  const [repairAmount, setRepairAmount] = useState("");
  const [repairDest, setRepairDest] = useState("JJ");
  const [repairError, setRepairError] = useState("");
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
  const [summaryDetailRow, setSummaryDetailRow] = useState(null); // summaryHistory row | null
  const [editTransactions, setEditTransactions] = useState([]);
  const [editActual, setEditActual] = useState("");
  const [editDate, setEditDate] = useState("");
  const [detailDesc, setDetailDesc] = useState("");
  const [detailAmount, setDetailAmount] = useState("");
  const [detailDest, setDetailDest] = useState("");
  const [detailRepairAmount, setDetailRepairAmount] = useState("");
  const [detailRepairDest, setDetailRepairDest] = useState("JJ");
  const [detailRepairError, setDetailRepairError] = useState("");
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
  const [shipIsCustomOrder, setShipIsCustomOrder] = useState(false);
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
  // 转手核对：自由配对模式（不需要双重确认）
  const [transferMode, setTransferMode] = useState("match");
  const [selectedOutgoingKeys, setSelectedOutgoingKeys] = useState(() => new Set());
  const [selectedIncomingKeys, setSelectedIncomingKeys] = useState(() => new Set());
  const [matchSaving, setMatchSaving] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [matchMsg, setMatchMsg] = useState("");

  // 账号管理（仅admin）
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminUsersLoading, setAdminUsersLoading] = useState(false);
  const [adminUsersError, setAdminUsersError] = useState("");
  const [deletingUserId, setDeletingUserId] = useState(null);

  const isAdmin = role === "admin";
  const editableWorkers = isAdmin ? WORKERS : WORKERS.filter(w => workerScope.includes(w));
  const editableShipWorkers = SHIP_WORKERS.filter(w => editableWorkers.includes(w));
  const writeBlocked = !ready || Boolean(loadError) || syncPending > 0 || (!isAdmin && editableWorkers.length === 0);

  async function ledgerWrite(name, args) {
    writeGate.current.begin();
    pendingSyncRef.current++;
    mutationRef.current++;
    setSyncPending(pendingSyncRef.current);
    let success = false;
    try {
      const result = await supabase.rpc(name, args);
      if (result.error) throw result.error;
      await loadAllData({ silent: true, ownWrite: true });
      success = true;
      return result;
    } catch (error) {
      setLoadError(t("写入未确认，已暂停操作。请刷新核对服务器记录后再继续。", "Write could not be confirmed. Refresh and review server records before continuing."));
      throw error;
    } finally {
      writeGate.current.finish(success);
      pendingSyncRef.current--;
      setSyncPending(pendingSyncRef.current);
    }
  }

  async function retrySync() {
    try { await loadAllData(); setReady(true); }
    catch { setLoadError(t("读取记录失败，当前禁止写入，请重试。", "Records could not be loaded. Writing is paused; retry.")); }
  }

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
      setReady(false);
      setWorkerScope([]);
      writeGate.current.synchronized = false;
      setAuthChecked(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    setAuthChecked(false);
    writeGate.current.synchronized = false;
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
    if (pendingSyncRef.current > 0) { setSaveMsg("正在同步，请完成后再退出。"); return; }
    await supabase.auth.signOut();
    setReady(false);
  }

  async function refreshWorkerData(worker) {
    const { data: rows, error } = await supabase.rpc("get_ledger_rows", {
      p_keys: [worker],
    });
    if (error) { writeGate.current.failed = true; setLoadError("读取记录失败，已暂停写入，请刷新。"); throw error; }
    const row = (rows || [])[0];
    setData((d) => ({
      ...d,
      [worker]: row ? { ...emptyWorkerData(), ...(row.data || {}) } : emptyWorkerData(),
    }));
  }

  // silent=true 是后台自动刷新：不动输入框里的阈值草稿；
  // 如果拉取期间本地刚好有新的改动，就丢掉这次结果，免得把刚记的那条冲掉
  async function loadAllData({ silent = false, ownWrite = false } = {}) {
    const startMutation = mutationRef.current;
    if (pendingSyncRef.current > (ownWrite ? 1 : 0)) return;
    try {
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
    const { data: scope, error: scopeError } = await supabase.rpc("ledger_get_worker_scope");
    if (scopeError) throw scopeError;
    if (mutationRef.current !== startMutation || pendingSyncRef.current > (ownWrite ? 1 : 0)) return;
    setWorkerScope(scope || []);
    const permitted = WORKERS.filter(w => (scope || []).includes(w));
    setActiveWorker(w => permitted.includes(w) ? w : permitted[0] || "");
    setShipFrom(w => permitted.includes(w) ? w : SHIP_WORKERS.find(w => permitted.includes(w)) || "");
    setData(next);
    setShipmentData(nextShipments);
    setTransferData(nextTransfers);
    if (!silent) {
      setThresholdDraft(String(nextTransfers.threshold ?? 0.05));
      setShipThresholdDraft(String(nextShipments.threshold ?? 0.05));
    }
    writeGate.current.recovered();
    setLoadError("");
    setLastSynced(new Date());
    } catch (error) {
      writeGate.current.failed = true;
      setLoadError(t("服务器记录未同步，已暂停写入，请重试。", "Server records are not synchronized. Writing is paused; retry."));
      throw error;
    }
  }
  loadAllDataRef.current = loadAllData;

  useEffect(() => {
    if (!session || !role) return;
    let cancelled = false;
    loadAllData()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("读取记录失败，当前禁止写入。请检查网络后重试。");
          setReady(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, role]);

  // 自动刷新：切回页面时刷新一次，页面开着时每45秒刷新一次，
  // 这样JJ和PD Lv2各用各的手机，也能及时看到对方刚记的流水和配对
  useEffect(() => {
    if (!session || !role || !ready) return;
    function tick() {
      if (document.visibilityState !== "visible") return;
      if (pendingSyncRef.current > 0) return;
      if (writeGate.current.failed) return; // Uncertain writes require an explicit refresh/review.
      const now = Date.now();
      if (now - lastAutoRefreshRef.current < 10000) return;
      lastAutoRefreshRef.current = now;
      const fn = loadAllDataRef.current;
      if (fn) fn({ silent: true }).catch(() => {});
    }
    const id = setInterval(tick, 45000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [session, role, ready]);

  useEffect(() => {
    setGoldbarConfirmed(false);
  }, [goldbarQty, goldbarActual]);
  useEffect(() => {
    setGoldbeanConfirmed(false);
  }, [goldbeanQty, goldbeanActual]);

  const goldbarState = calcDenomState(goldbarQty, goldbarActual, DENOMINATIONS_GOLDBAR);
  const goldbeanState = calcDenomState(goldbeanQty, goldbeanActual, DENOMINATIONS_GOLDBEAN);

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
      const { error } = await ledgerWrite("update_special_field", {
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

  async function addRow() {
    if (!writeGate.current.canWrite() || !editableWorkers.includes(activeWorker)) return;
    const amt = parseFloat(amountInput);
    if (!descInput.trim()) {
      setRowError(t("请填写描述", "Please enter a description"));
      return;
    }
    if (amountInput === "" || Number.isNaN(amt) || amt === 0) {
      setRowError(t("请填写有效的加减数量（不能为0）", "Please enter a valid amount (can't be 0)"));
      return;
    }
    if (!destInput) {
      setRowError(t("请选择去向/来源", "Please choose a destination/source"));
      return;
    }
    const item = { id: crypto.randomUUID(), desc: descInput.trim(), amount: amt, dest: destInput };
    if (!await addDraftItemLocal(activeWorker, dateInput, item)) return;
    setDescInput("");
    setAmountInput("");
    setDestInput("");
    setRowError("");
  }

  function removeRow(id) {
    removeDraftItemLocal(activeWorker, dateInput, id);
  }

  // 维修快捷录入：描述固定"维修"，去向/来源在 JJ / PD门市 之间选
  async function addRepairRow() {
    if (!writeGate.current.canWrite() || !editableWorkers.includes(activeWorker)) return;
    const amt = parseFloat(repairAmount);
    if (repairAmount === "" || Number.isNaN(amt) || amt === 0) {
      setRepairError(t("请填写有效的加减数量（不能为0）", "Please enter a valid amount (can't be 0)"));
      return;
    }
    const item = {
      id: crypto.randomUUID(),
      desc: t("维修", "Repair"),
      amount: amt,
      dest: repairDest,
    };
    if (!await addDraftItemLocal(activeWorker, dateInput, item)) return;
    setRepairAmount("");
    setRepairError("");
  }

  async function addDraftItemLocal(worker, date, item) {
    if (!editableWorkers.includes(worker)) return false;
    try {
      await ledgerWrite("upsert_draft_item", { p_worker: worker, p_date: date, p_item: item });
      return true;
    } catch { setSaveMsg("记录未确认，请刷新核对服务器后再继续。"); return false; }
  }

  async function removeDraftItemLocal(worker, date, itemId) {
    if (!editableWorkers.includes(worker)) return;
    try {
      await ledgerWrite("remove_draft_item", { p_worker: worker, p_date: date, p_item_id: String(itemId) });
      await refreshWorkerData(worker);
    } catch { setSaveMsg("删除未确认，请刷新核对服务器后再继续。"); }
  }

  // 整行覆盖前先拉服务器上最新的那一行，再在它的基础上改，
  // 避免用页面里已经过期的数据，把别人刚记的流水/配对冲掉
  async function fetchRowFresh(key) {
    if (WORKERS.includes(key)) {
      const { data: rows, error } = await supabase.rpc("get_ledger_rows", { p_keys: [key] });
      if (error) throw error;
      const row = (rows || [])[0];
      return { ...emptyWorkerData(), ...((row && row.data) || {}) };
    }
    const { data: raw, error } = await supabase.rpc("get_special_row", { p_key: key });
    if (error) throw error;
    const base = key === SPECIAL_KEYS.SHIPMENTS ? emptyShipmentData() : emptyTransferData();
    return { ...base, ...(raw || {}) };
  }

  async function refreshSpecialData(key, setter, emptyFn) {
    const { data: raw, error } = await supabase.rpc("get_special_row", { p_key: key });
    if (error) { writeGate.current.failed = true; setLoadError("读取记录失败，已暂停写入，请刷新。"); throw error; }
    setter({ ...emptyFn(), ...(raw || {}) });
  }

  // ---- 出货记录 ----
  function addShipItem() {
    const baseCat = shipCategory === "OTHER" ? shipCategoryCustom.trim() : shipCategory;
    const cat = shipIsCustomOrder ? `订工-${baseCat}` : baseCat;
    const w = parseFloat(shipWeight);
    if (!baseCat) {
      setShipRowError("请填写类别");
      return;
    }
    if (shipWeight === "" || Number.isNaN(w) || w <= 0) {
      setShipRowError("请填写有效重量");
      return;
    }
    setShipItems((list) => [
      ...list,
      { id: crypto.randomUUID(), category: cat, weight: w },
    ]);
    setShipCategoryCustom("");
    setShipWeight("");
    setShipRowError("");
  }

  function removeShipItem(id) {
    setShipItems((list) => list.filter((i) => i.id !== id));
  }

  function itemsSummary(items) {
    return (items || [])
      .map(
        (i) =>
          `${i.category} ${fmtPlain(i.weight)}g` + (i.breakdown ? `（${i.breakdown}）` : "")
      )
      .join("、");
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
    try {
      await ledgerWrite("update_special_field", { p_key: SPECIAL_KEYS.SHIPMENTS, p_field: "threshold", p_value: t });
      await refreshSpecialData(SPECIAL_KEYS.SHIPMENTS, setShipmentData, emptyShipmentData);
    } catch {
      setShipMsg("阈值更新失败，检查网络后重试");
    }
  }

  async function saveShipment() {
    if (!writeGate.current.canWrite() || !editableShipWorkers.includes(shipFrom)) return;
    setShipMsg("");
    if (!canSaveShipment()) {
      setShipMsg("GOLDBAR 或 GOLDBEAN 的实重跟小计差超过0.03g，请先点下面的确认按钮再保存");
      return;
    }
    const items = [...shipItems];
    if (goldbarState.finalWeight > 0) {
      items.push({
        id: crypto.randomUUID(),
        category: "GOLDBAR",
        weight: Math.round(goldbarState.finalWeight * 100) / 100,
        breakdown: denomBreakdown(goldbarQty, DENOMINATIONS_GOLDBAR),
      });
    }
    if (goldbeanState.finalWeight > 0) {
      items.push({
        id: crypto.randomUUID(),
        category: "GOLDBEAN",
        weight: Math.round(goldbeanState.finalWeight * 100) / 100,
        breakdown: denomBreakdown(goldbeanQty, DENOMINATIONS_GOLDBEAN),
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
    const sentItemId = crypto.randomUUID();
    const record = {
      id: crypto.randomUUID(),
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
    try {
      const { error } = await ledgerWrite("shipment_create_with_flow", {
        p_record: record, p_flow_description: autoDesc,
      });
      if (error) throw error;
      await refreshWorkerData(shipFrom);
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
    if (!isAdmin || !writeGate.current.canWrite()) return;
    setShipConfirmingId(record.id);
    setShipConfirmDate(todayStr());
    setShipConfirmWeight("");
    setShipConfirmSerial("");
    setShipConfirmError("");
  }

  async function confirmShipment() {
    if (!isAdmin || !writeGate.current.canWrite()) return;
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
      const { error } = await ledgerWrite("update_special_record", {
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

  async function deleteShipmentRecord(record) {
    if (!isAdmin || !writeGate.current.canWrite()) return;
    if (!window.confirm("确定撤销这条出货及其关联流水？操作会留档。")) return;
    try {
      await ledgerWrite("shipment_delete_with_flow", { p_record_id: record.id, p_reason: "Cancelled by administrator from shipment page" });
      await refreshWorkerData(record.fromWorker);
      await refreshSpecialData(SPECIAL_KEYS.SHIPMENTS, setShipmentData, emptyShipmentData);
    } catch { setShipMsg("取消失败，流水可能已经归档；请管理员复核。记录未被部分删除。"); }
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

  // ---- 总览：JJ+PD Lv1+PD Lv2+Lv1车花 汇总 ----
  const summaryLatest = useMemo(() => {
    const rows = SUMMARY_WORKERS.map((w) => {
      const wd = data[w] || emptyWorkerData();
      const lastRecord = wd.history.length ? wd.history[wd.history.length - 1] : null;
      return {
        worker: w,
        actual: wd.lastWeight,
        expected: lastRecord ? lastRecord.expected : null,
        loss: lastRecord ? lastRecord.loss : null,
        date: lastRecord ? lastRecord.date : null,
      };
    });
    const sum = (key) => {
      const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
      return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
    };
    return {
      rows,
      totalActual: sum("actual"),
      totalExpected: sum("expected"),
      totalLoss: sum("loss"),
    };
  }, [data]);

  const summaryHistory = useMemo(() => {
    const byDate = new Map();
    for (const w of SUMMARY_WORKERS) {
      const wd = data[w] || emptyWorkerData();
      for (const r of wd.history) {
        if (!byDate.has(r.date)) byDate.set(r.date, {});
        byDate.get(r.date)[w] = r;
      }
    }
    const dates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
    return dates.slice(0, 30).map((date) => {
      const byWorker = byDate.get(date);
      const complete = SUMMARY_WORKERS.every((w) => byWorker[w]);
      let totalActual = 0;
      let anyActual = false;
      for (const w of SUMMARY_WORKERS) {
        if (byWorker[w]) {
          totalActual += byWorker[w].actual;
          anyActual = true;
        }
      }
      let totalExpected = null;
      let totalLoss = null;
      if (complete) {
        totalExpected = SUMMARY_WORKERS.reduce(
          (s, w) => s + (byWorker[w].expected ?? 0),
          0
        );
        totalLoss = SUMMARY_WORKERS.reduce((s, w) => s + (byWorker[w].loss ?? 0), 0);
      }
      return {
        date,
        byWorker,
        complete,
        totalActual: anyActual ? totalActual : null,
        totalExpected,
        totalLoss,
      };
    });
  }, [data]);

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
  async function refreshAll() {
    setRefreshingAll(true);
    try {
      await loadAllData();
      setMatchMsg(t("已刷新最新数据", "Refreshed with the latest data"));
    } catch {
      setMatchMsg(t("刷新失败，检查网络后重试", "Refresh failed, check your connection and retry"));
    } finally {
      setRefreshingAll(false);
    }
  }

  async function saveThreshold() {
    if (!isAdmin) return;
    const t = parseFloat(thresholdDraft);
    if (Number.isNaN(t) || t < 0) return;
    try {
      await ledgerWrite("update_special_field", { p_key: SPECIAL_KEYS.TRANSFERS, p_field: "threshold", p_value: t });
      await refreshSpecialData(SPECIAL_KEYS.TRANSFERS, setTransferData, emptyTransferData);
    } catch {
      setMatchMsg("阈值更新失败，检查网络后重试");
    }
  }
  // 送出方先保存（半保存），自动写入送出方当天流水（减）
  // ---- 自由配对模式 ----
  const matchRecords = useMemo(
    () => transferData.history.filter((r) => r.kind === "match"),
    [transferData.history]
  );
  // 兼容旧格式（单笔配对）和新格式（多笔配对）
  function getOutgoingList(r) {
    if (r.outgoing) return r.outgoing;
    if (r.itemIdA) {
      return [{ worker: r.workerA, date: r.dateA, desc: r.descA, amount: r.amountA, itemId: r.itemIdA }];
    }
    return [];
  }
  function getIncomingList(r) {
    if (r.incoming) return r.incoming;
    if (r.itemIdB) {
      return [{ worker: r.workerB, date: r.dateB, desc: r.descB, amount: r.amountB, itemId: r.itemIdB }];
    }
    return [];
  }
  function getTotalOut(r) {
    return r.totalOut !== undefined ? r.totalOut : Math.abs(r.amountA || 0);
  }
  function getTotalIn(r) {
    return r.totalIn !== undefined ? r.totalIn : r.amountB || 0;
  }

  // ---- 总览：拼成表格式（跟原本手工记账格式一样，配对的两边同一天就合并一行）----
  const spreadsheetRows = useMemo(() => {
    const matchInfoByItemId = new Map();
    for (const r of matchRecords) {
      const outs = getOutgoingList(r);
      const ins = getIncomingList(r);
      const simple = outs.length === 1 && ins.length === 1;
      for (const i of outs) {
        matchInfoByItemId.set(i.itemId, { record: r, partners: ins, simple });
      }
      for (const i of ins) {
        matchInfoByItemId.set(i.itemId, { record: r, partners: outs, simple });
      }
    }

    const consumed = new Set();
    const rows = [];
    for (const w of SUMMARY_WORKERS) {
      const hist = (data[w] && data[w].history) || [];
      for (const rec of hist) {
        for (const tx of rec.transactions || []) {
          const key = `${w}|${rec.date}|${tx.id}`;
          if (consumed.has(key)) continue;
          const info = matchInfoByItemId.get(tx.id);
          if (info && info.simple) {
            const partner = info.partners[0];
            if (partner.date === rec.date && SUMMARY_WORKERS.includes(partner.worker)) {
              consumed.add(key);
              consumed.add(`${partner.worker}|${partner.date}|${partner.itemId}`);
              rows.push({
                date: rec.date,
                desc: tx.desc,
                matched: true,
                matchId: info.record.id,
                cells: { [w]: tx.amount, [partner.worker]: partner.amount },
              });
              continue;
            }
          }
          consumed.add(key);
          rows.push({
            date: rec.date,
            desc: tx.desc + (tx.dest ? ` [${tx.dest}]` : ""),
            matched: !!info,
            matchId: info ? info.record.id : null,
            cells: { [w]: tx.amount },
          });
        }
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  }, [data, matchRecords]);

  const spreadsheetByDate = useMemo(() => {
    const byDate = new Map();
    for (const row of spreadsheetRows) {
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date).push(row);
    }
    const summaryByDate = new Map();
    for (const h of summaryHistory) summaryByDate.set(h.date, h);
    const dates = Array.from(byDate.keys()).sort((a, b) => a.localeCompare(b));
    return dates.map((date) => ({
      date,
      rows: byDate.get(date),
      summary: summaryByDate.get(date) || null,
    }));
  }, [spreadsheetRows, summaryHistory]);

  function matchTagColor(matchId) {
    if (!matchId) return "";
    let hash = 0;
    for (let i = 0; i < matchId.length; i++) hash = (hash * 31 + matchId.charCodeAt(i)) % 360;
    return `hsl(${hash}, 60%, 55%)`;
  }
  const matchedItemIds = useMemo(() => {
    const s = new Set();
    for (const r of matchRecords) {
      if (r.outgoing) r.outgoing.forEach((i) => s.add(i.itemId));
      else if (r.itemIdA) s.add(r.itemIdA);
      if (r.incoming) r.incoming.forEach((i) => s.add(i.itemId));
      else if (r.itemIdB) s.add(r.itemIdB);
    }
    return s;
  }, [matchRecords]);

  const matchableItems = useMemo(() => {
    const items = [];
    for (const w of WORKERS) {
      const drafts = (data[w] && data[w].drafts) || {};
      for (const date of Object.keys(drafts)) {
        for (const item of drafts[date] || []) {
          if (WORKERS.includes(item.dest) && !matchedItemIds.has(item.id)) {
            items.push({ ...item, worker: w, date });
          }
        }
      }
    }
    return items;
  }, [data, matchedItemIds]);

  // 最近2天未配对统计仅作提醒，绝不阻塞正常录入
  const recentUnmatchedCount = useMemo(() => {
    const cutoffStr = shiftDay(todayStr(), -2);
    return matchableItems.filter((i) => i.date >= cutoffStr).length;
  }, [matchableItems]);
  function itemKey(item) {
    return `${item.worker}|${item.date}|${item.id}`;
  }
  const outgoingItems = useMemo(
    () =>
      matchableItems
        .filter((i) => i.amount < 0)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [matchableItems]
  );
  const incomingItems = useMemo(
    () =>
      matchableItems
        .filter((i) => i.amount > 0)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [matchableItems]
  );
  function toggleOutgoing(key) {
    setSelectedOutgoingKeys((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleIncoming(key) {
    setSelectedIncomingKeys((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectedOutgoingList = useMemo(
    () => outgoingItems.filter((i) => selectedOutgoingKeys.has(itemKey(i))),
    [outgoingItems, selectedOutgoingKeys]
  );
  const selectedIncomingList = useMemo(
    () => incomingItems.filter((i) => selectedIncomingKeys.has(itemKey(i))),
    [incomingItems, selectedIncomingKeys]
  );
  const selTotalOut = selectedOutgoingList.reduce((s, i) => s + Math.abs(i.amount), 0);
  const selTotalIn = selectedIncomingList.reduce((s, i) => s + i.amount, 0);
  const selDiff = selTotalIn - selTotalOut;

  async function confirmMatch() {
    if (selectedOutgoingList.length === 0 || selectedIncomingList.length === 0) return;
    setMatchSaving(true);
    setMatchMsg("");
    try {
      const outgoingIds = selectedOutgoingList.map((i) => String(i.id));
      const incomingIds = selectedIncomingList.map((i) => String(i.id));
      const { data: preview, error: previewError } = await supabase.rpc("transfer_preview_match", {
        p_outgoing_ids: outgoingIds, p_incoming_ids: incomingIds,
      });
      if (previewError) throw previewError;
      if (!preview?.valid) throw new Error(preview?.reason || "invalid_match");
      const { error } = await ledgerWrite("transfer_apply_match", {
        p_outgoing_ids: outgoingIds, p_incoming_ids: incomingIds, p_source: "manual_ui",
      });
      if (error) throw error;
      await refreshSpecialData(SPECIAL_KEYS.TRANSFERS, setTransferData, emptyTransferData);
      setSelectedOutgoingKeys(new Set());
      setSelectedIncomingKeys(new Set());
      setMatchMsg(t("配对成功", "Paired"));
    } catch (error) {
      const reason = error.message || "";
      const messages = {
        item_already_matched: t("其中有记录已经配对，请刷新后重新选择", "Some entries are already paired. Refresh and select again."),
        worker_pair_mismatch: t("送出和接收必须属于同一组 Worker，且去向/来源互相对应", "Select one worker pair with reciprocal destination/source."),
        date_range_exceeded: t("所选记录日期跨度超过7天，或包含未来日期", "Selected entries span more than 7 days or include a future date."),
        item_not_found: t("记录已变动或不存在，请刷新后重新选择", "Entries have changed or no longer exist. Refresh and select again."),
        admin_required: t("只有管理员可以配对", "Only admins can pair entries."),
        weight_mismatch_requires_investigation: t("重量差超过0.20g，请建立异常并调查后复核", "Difference exceeds 0.20g. Create an issue and investigate before review."),
        item_has_open_issue: t("所选流水有待处理异常，请管理员复核异常后再配对", "Selected entries have open issues. Administrator review is required."),
      };
      setMatchMsg(messages[reason] || t("配对失败，检查网络或选择的记录后重试", "Pairing failed. Check your connection and selection."));
    } finally {
      setMatchSaving(false);
    }
  }

  function unmatch(record) {
    if (
      !window.confirm(
        t(
          "确定取消这组配对？（两边各自的流水记录不会被删除，只是取消配对标记）",
          "Cancel this pairing? (Neither side's flow entry is deleted — only the pairing link is removed.)"
        )
      )
    )
      return;
    ledgerWrite("transfer_undo_match", { p_match_id: String(record.id), p_reason: "Cancelled from manual UI" })
      .then(({ error }) => {
        if (!error) {
          refreshSpecialData(SPECIAL_KEYS.TRANSFERS, setTransferData, emptyTransferData);
        } else {
          setMatchMsg(t("取消配对失败，检查网络后重试", "Failed to unpair, check your connection and retry"));
        }
      }).catch(() => setMatchMsg(t("取消配对未确认，请刷新后复核。", "Unpair could not be confirmed. Refresh and review.")));
  }

  // 直接删掉待配对列表里的这条流水记录本身（不只是从配对列表移除，
  // 因为这些本来就是各worker今日流水里的记录，删了就是从流水里删掉了）
  function deleteUnmatchedItem(item) {
    if (
      !window.confirm(
        t(
          `确定删除这条流水记录？（${item.worker} · ${item.date} · ${item.desc}，这是真的从流水里删掉，不是撤销配对）`,
          `Delete this flow entry? (${item.worker} · ${item.date} · ${item.desc} — this really removes it from the flow, not just from the pairing list.)`
        )
      )
    )
      return;
    removeDraftItemLocal(item.worker, item.date, item.id);
  }

  async function saveDay() {
    if (!writeGate.current.canWrite()) { setSaveMsg("流水尚未同步，暂时不能结算。"); return; }
    setActualError("");
    setSaveMsg("");
    if (actualInput === "" || Number.isNaN(rawScaleNum)) {
      setActualError("请填写这一天过秤读到的重量");
      return;
    }
    setSaving(true);
    try {
      const { error } = await ledgerWrite("save_day", {
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
    try {
      await ledgerWrite("ledger_undo_last_day", {
        p_worker: activeWorker, p_expected_record: cur.history[cur.history.length - 1],
        p_reason: "Administrator undid the last day; flows returned to draft",
      });
      await refreshWorkerData(activeWorker);
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
      setDetailRowError(t("请填写描述", "Please enter a description"));
      return;
    }
    if (detailAmount === "" || Number.isNaN(amt) || amt === 0) {
      setDetailRowError(t("请填写有效的加减数量（不能为0）", "Please enter a valid amount (can't be 0)"));
      return;
    }
    if (!detailDest) {
      setDetailRowError(t("请选择去向/来源", "Please choose a destination/source"));
      return;
    }
    setEditTransactions((list) => [
      ...list,
      { id: crypto.randomUUID(), desc: detailDesc.trim(), amount: amt, dest: detailDest },
    ]);
    setDetailDesc("");
    setDetailAmount("");
    setDetailDest("");
    setDetailRowError("");
  }

  function removeDetailRow(id) {
    setEditTransactions((list) => list.filter((t) => t.id !== id));
  }

  // 详情弹窗里的维修快捷录入，逻辑跟主流水那个一样
  function addDetailRepairRow() {
    const amt = parseFloat(detailRepairAmount);
    if (detailRepairAmount === "" || Number.isNaN(amt) || amt === 0) {
      setDetailRepairError(t("请填写有效的加减数量（不能为0）", "Please enter a valid amount (can't be 0)"));
      return;
    }
    setEditTransactions((list) => [
      ...list,
      {
        id: crypto.randomUUID(),
        desc: t("维修", "Repair"),
        amount: amt,
        dest: detailRepairDest,
      },
    ]);
    setDetailRepairAmount("");
    setDetailRepairError("");
  }

  async function saveDetailEdit() {
    if (!showDetail || !writeGate.current.canWrite() || !editableWorkers.includes(showDetail.worker)) return;
    const { worker, index } = showDetail;
    const record = data[worker].history[index];
    if (record.exported) return;
    const num = parseFloat(editActual);
    if (editActual === "" || Number.isNaN(num)) {
      setDetailError(t("请填写有效的实重", "Please enter a valid actual weight"));
      return;
    }
    if (!editDate) {
      setDetailError(t("请选择日期", "Please choose a date"));
      return;
    }
    setDetailSaving(true);
    try {
      const { error } = await ledgerWrite("edit_history_record", {
        p_worker: worker,
        p_old_date: record.date,
        p_new_date: editDate,
        p_transactions: editTransactions,
        p_actual: num,
      });
      if (error) throw error;
      await refreshWorkerData(worker);
      setShowDetail(null);
    } catch {
      setDetailError(
        t(
          "保存失败——检查网络，或者这天已经超出你能改的范围（最近3天）",
          "Save failed — check your connection, or this date may be outside what you're allowed to edit (last 3 days)"
        )
      );
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
    if (!isAdmin || !writeGate.current.canWrite()) return;
    setExporting(true);
    setExportMsg("");
    try {
      // 按日期分组，收集所有还没导出过的记录
      const byDate = new Map(); // date -> { worker: record }
      const keys = [];
      let totalDays = 0;
      let totalLines = 0;
      for (const w of WORKERS) {
        const hist = data[w]?.history || [];
        hist.forEach((r) => {
          if (r.exported) return;
          keys.push({ worker: w, date: r.date, record: structuredClone(r) });
          if (!byDate.has(r.date)) byDate.set(r.date, {});
          byDate.get(r.date)[w] = r;
          totalDays += 1;
          totalLines += (r.transactions || []).length;
        });
      }
      if (byDate.size === 0) {
        setExportMsg(t("没有还没导出过的记录", "Nothing new to export"));
        setExporting(false);
        return;
      }
      const dates = Array.from(byDate.keys()).sort();
      const rows = [];
      const colDate = t("日期", "Date");
      const colType = t("类型", "Type");
      const colDesc = t("描述", "Description");
      const colAmount = t("加减(g)", "Amount(g)");
      const colDest = t("去向/来源", "Destination/Source");
      const colPrev = t("上次实重", "Prev. actual");
      const colTotal = t("变动合计", "Net change");
      const colExpected = t("要有", "Expected");
      const colActual = t("实重", "Actual");
      const colLoss = t("损耗", "Loss");
      const typeEntry = t("流水", "Entry");
      const typeSummary = t("统计", "Summary");

      for (const date of dates) {
        const byWorker = byDate.get(date);
        for (const w of WORKERS) {
          const rec = byWorker[w];
          if (!rec) continue;
          (rec.transactions || []).forEach((tx) => {
            rows.push({
              [colDate]: date,
              [colType]: typeEntry,
              Worker: w,
              [colDesc]: tx.desc,
              [colAmount]: tx.amount,
              [colDest]: tx.dest || "",
              [colPrev]: "",
              [colTotal]: "",
              [colExpected]: "",
              [colActual]: "",
              [colLoss]: "",
            });
          });
        }
        for (const w of WORKERS) {
          const rec = byWorker[w];
          if (!rec) continue;
          rows.push({
            [colDate]: date,
            [colType]: typeSummary,
            Worker: w,
            [colDesc]: "",
            [colAmount]: "",
            [colDest]: "",
            [colPrev]: rec.prevWeight ?? "",
            [colTotal]: rec.total ?? "",
            [colExpected]: rec.expected ?? "",
            [colActual]: rec.actual,
            [colLoss]: rec.loss ?? "",
          });
        }
        rows.push({});
      }
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, t("对账记录", "Reconciliation"));

      // 第二个sheet：跟手工记账本一样的格式（JJ/PD Lv1/PD Lv2/Lv1车花并排+/-栏，配对的转手合并一行）
      const dateSet = new Set(dates);
      const ledgerDays = spreadsheetByDate.filter((d) => dateSet.has(d.date));
      if (ledgerDays.length > 0) {
        const headerRow1 = [t("日期", "Date"), t("项目", "Item")];
        const headerRow2 = ["", ""];
        for (const w of SUMMARY_WORKERS) {
          headerRow1.push(w, "");
          headerRow2.push("+", "-");
        }
        const aoa = [headerRow1, headerRow2];
        for (const day of ledgerDays) {
          for (const row of day.rows) {
            const line = [day.rows.indexOf(row) === 0 ? day.date : "", row.desc];
            for (const w of SUMMARY_WORKERS) {
              const amt = row.cells[w];
              line.push(
                amt !== undefined && amt > 0 ? Math.round(amt * 100) / 100 : "",
                amt !== undefined && amt < 0 ? Math.round(Math.abs(amt) * 100) / 100 : ""
              );
            }
            aoa.push(line);
          }
          if (day.summary) {
            for (const [label, field] of [
              [t("要有", "Expected"), "expected"],
              [t("实重", "Actual"), "actual"],
              [t("损耗", "Loss"), "loss"],
            ]) {
              const line = ["", label];
              for (const w of SUMMARY_WORKERS) {
                const rec = day.summary.byWorker[w];
                const v = rec ? rec[field] : null;
                line.push(v !== null && v !== undefined ? Math.round(v * 100) / 100 : "", "");
              }
              aoa.push(line);
            }
          }
          aoa.push([]);
        }
        const ws2 = XLSX.utils.aoa_to_sheet(aoa);
        ws2["!merges"] = SUMMARY_WORKERS.map((_, i) => ({
          s: { r: 0, c: 2 + i * 2 },
          e: { r: 0, c: 3 + i * 2 },
        }));
        XLSX.utils.book_append_sheet(wb, ws2, t("手工记账格式", "Ledger format"));
      }

      XLSX.writeFile(wb, `金重对账_${todayStr()}.xlsx`);
      setPendingExportKeys(keys);
      setExportMsg(
        t(
          `已导出 ${totalDays} 天、${totalLines} 条流水。确认文件保存好后，可以点下面按钮清空这批流水明细（汇总数字会保留）。`,
          `Exported ${totalDays} day(s), ${totalLines} line(s). Once you've saved the file, you can clear this batch's line items below (summary numbers stay).`
        )
      );
    } catch {
      setExportMsg(t("导出失败，请重试", "Export failed, please retry"));
    } finally {
      setExporting(false);
    }
  }

  async function handleClearExported() {
    if (!isAdmin) return;
    if (!pendingExportKeys) return;
    setClearing(true);
    try {
      const { data: result } = await ledgerWrite("ledger_archive_batch", { p_records: pendingExportKeys });
      await loadAllData();
      setPendingExportKeys(null);
      setConfirmClear(false);
      setExportMsg("已归档 " + result.archived_days + " 天；保留 " + result.retained.length + " 天待配对、异常或出货原始流水。汇总不变。");
    } catch {
      setExportMsg("归档未执行：记录可能在导出后有变动，请刷新并重新导出。整批操作不会部分成功。");
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
        <div>
          <p>{loadError || t("正在加载记录…", "Loading records…")}</p>
          {loadError && <button onClick={retrySync} className="mt-3 border rounded px-4 py-2">{t("重试读取", "Retry loading")}</button>}
          <button onClick={handleLogout} className="ml-3">{t("退出", "Sign out")}</button>
        </div>
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
            <button onClick={retrySync} className="ml-3 underline">{t("刷新核对", "Refresh and review")}</button>
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

      <p role="status" className="text-xs text-stone-400 mb-3">
        {syncPending > 0 ? t("正在同步，暂时不能结算或修改…", "Synchronizing; settlement and edits are paused…") :
          lastSynced ? t("最后完整同步：", "Last full sync: ") + lastSynced.toLocaleTimeString("en-GB", { timeZone: "Asia/Kuala_Lumpur" }) : ""}
      </p>
      <fieldset disabled={writeBlocked} className="min-w-0">
      {!isAdmin && (
        <p className="text-xs text-stone-600 mb-4">
          {t(
            "你只能录入和修改已分配部门最近3天的记录；转手配对和解除异常由管理员 / AI 每周处理。",
            "You have a standard account: only the last 3 days are visible, and you can only edit records within those 3 days. Export and undo remain admin-only."
          )}
        </p>
      )}

      <div className="flex gap-2 mb-6 overflow-x-auto -mx-5 px-5 md:mx-0 md:px-0 md:flex-wrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[
          { key: "summary", label: t("总览", "Overview"), icon: LayoutDashboard },
          { key: "workers", label: t("对账", "Reconcile"), icon: Scale },
          { key: "shipments", label: t("出货记录", "Shipments"), icon: Truck },
          ...(isAdmin ? [{ key: "transfers", label: t("转手核对", "Transfers"), icon: ArrowLeftRight }] : []),
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

      <TransferIssues worker={view === "transfers" && isAdmin ? null : activeWorker} lang={lang} pinned={view === "transfers"} />
      {!isAdmin && editableWorkers.length === 0 && <p className="text-rose-400">账号尚未分配录入部门，请管理员设置。</p>}

      {view === "summary" && (
        <>
          <p className="text-xs text-stone-500 mb-4">
            {t(
              `汇总 ${SUMMARY_WORKERS.join("、")} 这几个worker的实重、要有、损耗`,
              `Combined actual, expected, and loss across ${SUMMARY_WORKERS.join(", ")}`
            )}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
              <p className="text-xs text-stone-500 mb-1">{t("合计实重", "Total actual")}</p>
              <p className="text-xl font-mono tabular-nums text-stone-100">
                {summaryLatest.totalActual === null ? "-" : fmtPlain(summaryLatest.totalActual) + " g"}
              </p>
            </div>
            <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
              <p className="text-xs text-stone-500 mb-1">{t("合计要有", "Total expected")}</p>
              <p className="text-xl font-mono tabular-nums text-stone-100">
                {summaryLatest.totalExpected === null ? "-" : fmtPlain(summaryLatest.totalExpected) + " g"}
              </p>
            </div>
            <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
              <p className="text-xs text-stone-500 mb-1">{t("合计损耗", "Total loss")}</p>
              <p
                className={
                  "text-xl font-mono tabular-nums " +
                  (summaryLatest.totalLoss !== null && Math.abs(summaryLatest.totalLoss) > LOSS_THRESHOLD
                    ? "text-rose-400"
                    : "text-stone-100")
                }
              >
                {summaryLatest.totalLoss === null ? "-" : fmt(summaryLatest.totalLoss) + " g"}
              </p>
            </div>
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              {t("各worker最新一天", "Each worker's latest day")}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-stone-500 border-b border-stone-800">
                    <th className="text-left py-2 font-normal">Worker</th>
                    <th className="text-left py-2 font-normal">{t("日期", "Date")}</th>
                    <th className="text-right py-2 font-normal">{t("要有", "Expected")}</th>
                    <th className="text-right py-2 font-normal">{t("实重", "Actual")}</th>
                    <th className="text-right py-2 font-normal">{t("损耗", "Loss")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-800">
                  {summaryLatest.rows.map((r) => {
                    const over = r.loss !== null && Math.abs(r.loss) > LOSS_THRESHOLD;
                    return (
                      <tr key={r.worker}>
                        <td className="py-2 text-stone-300">{r.worker}</td>
                        <td className="py-2 text-stone-500 text-xs">{r.date || "-"}</td>
                        <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                          {r.expected === null ? "-" : fmtPlain(r.expected)}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums text-stone-100">
                          {r.actual === null ? "-" : fmtPlain(r.actual)}
                        </td>
                        <td
                          className={
                            "py-2 text-right font-mono tabular-nums " +
                            (r.loss === null ? "text-stone-600" : over ? "text-rose-400" : "text-emerald-400")
                          }
                        >
                          {r.loss === null ? "-" : fmt(r.loss)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t border-stone-700">
                    <td className="py-2 text-stone-200 font-medium" colSpan={2}>
                      {t("合计", "Total")}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-stone-200 font-medium">
                      {summaryLatest.totalExpected === null ? "-" : fmtPlain(summaryLatest.totalExpected)}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-stone-200 font-medium">
                      {summaryLatest.totalActual === null ? "-" : fmtPlain(summaryLatest.totalActual)}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-stone-200 font-medium">
                      {summaryLatest.totalLoss === null ? "-" : fmt(summaryLatest.totalLoss)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
            <h2 className="text-sm font-medium text-stone-300 mb-3 flex items-center gap-2">
              <History className="w-4 h-4" />
              {t("历史合并记录（按日期，最近30天，点日期看完整表格）", "Combined history (by date, last 30 days, click a date for the full table)")}
            </h2>
            {summaryHistory.length === 0 ? (
              <p className="text-sm text-stone-600 py-4 text-center">
                {t("还没有历史记录", "No history yet")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-stone-500 border-b border-stone-800">
                      <th className="text-left py-2 font-normal">{t("日期", "Date")}</th>
                      {SUMMARY_WORKERS.map((w) => (
                        <th key={w} className="text-right py-2 font-normal">
                          {w}
                        </th>
                      ))}
                      <th className="text-right py-2 font-normal">{t("合计实重", "Total actual")}</th>
                      <th className="text-right py-2 font-normal">{t("合计损耗", "Total loss")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800">
                    {summaryHistory.map((row) => {
                      const over =
                        row.totalLoss !== null && Math.abs(row.totalLoss) > LOSS_THRESHOLD;
                      return (
                        <tr
                          key={row.date}
                          className="hover:bg-stone-950/50 cursor-pointer"
                          onClick={() => setSummaryDetailRow(row)}
                        >
                          <td className="py-2 text-amber-400 hover:text-amber-300 underline decoration-dotted">
                            {row.date}
                            {!row.complete && (
                              <span className="text-stone-600"> *</span>
                            )}
                          </td>
                          {SUMMARY_WORKERS.map((w) => (
                            <td
                              key={w}
                              className="py-2 text-right font-mono tabular-nums text-stone-300"
                            >
                              {row.byWorker[w] ? fmtPlain(row.byWorker[w].actual) : "-"}
                            </td>
                          ))}
                          <td className="py-2 text-right font-mono tabular-nums text-stone-100">
                            {row.totalActual === null ? "-" : fmtPlain(row.totalActual)}
                          </td>
                          <td
                            className={
                              "py-2 text-right font-mono tabular-nums " +
                              (row.totalLoss === null
                                ? "text-stone-600"
                                : over
                                ? "text-rose-400"
                                : "text-emerald-400")
                            }
                          >
                            {row.totalLoss === null ? "-" : fmt(row.totalLoss)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-stone-600 mt-3">
              {t(
                "* 标记的日期不是4个worker都有记录，合计要有/损耗留空（避免算错）；合计实重只加有记录的那几个。",
                "* marked dates don't have all 4 workers recorded; total expected/loss is left blank to avoid a misleading number. Total actual only adds whichever workers reported."
              )}
            </p>
          </div>
        </>
      )}

      {summaryDetailRow && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
          onClick={() => setSummaryDetailRow(null)}
        >
          <div
            className="bg-stone-900 border border-stone-700 rounded-2xl p-5 md:p-6 max-w-3xl w-full max-h-[88vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-stone-200">
                {summaryDetailRow.date}
                {!summaryDetailRow.complete && (
                  <span className="text-stone-600 text-xs ml-2">
                    {t("（不是4个worker都有记录）", "(not all 4 workers recorded)")}
                  </span>
                )}
              </h3>
              <button
                onClick={() => setSummaryDetailRow(null)}
                className="text-stone-500 hover:text-stone-300 p-2 -m-2 rounded-lg active:bg-stone-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-x-auto mb-5">
              <table className="w-full text-sm min-w-[480px]">
                <thead>
                  <tr className="text-xs text-stone-500 border-b border-stone-800">
                    <th className="text-left py-1.5 font-normal"></th>
                    {SUMMARY_WORKERS.map((w) => (
                      <th key={w} className="text-right py-1.5 font-normal">
                        {w}
                      </th>
                    ))}
                    <th className="text-right py-1.5 font-normal text-stone-400">
                      {t("合计", "Total")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-800">
                  <tr>
                    <td className="py-1.5 text-stone-500">{t("上次实重", "Prev.")}</td>
                    {SUMMARY_WORKERS.map((w) => (
                      <td
                        key={w}
                        className="py-1.5 text-right font-mono tabular-nums text-stone-400"
                      >
                        {summaryDetailRow.byWorker[w] && summaryDetailRow.byWorker[w].prevWeight !== null
                          ? fmtPlain(summaryDetailRow.byWorker[w].prevWeight)
                          : "-"}
                      </td>
                    ))}
                    <td className="py-1.5"></td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-stone-500">{t("要有", "Expected")}</td>
                    {SUMMARY_WORKERS.map((w) => (
                      <td
                        key={w}
                        className="py-1.5 text-right font-mono tabular-nums text-stone-300"
                      >
                        {summaryDetailRow.byWorker[w] && summaryDetailRow.byWorker[w].expected !== null
                          ? fmtPlain(summaryDetailRow.byWorker[w].expected)
                          : "-"}
                      </td>
                    ))}
                    <td className="py-1.5 text-right font-mono tabular-nums text-stone-300">
                      {summaryDetailRow.totalExpected === null ? "-" : fmtPlain(summaryDetailRow.totalExpected)}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-stone-500">{t("实重", "Actual")}</td>
                    {SUMMARY_WORKERS.map((w) => (
                      <td
                        key={w}
                        className="py-1.5 text-right font-mono tabular-nums text-stone-100"
                      >
                        {summaryDetailRow.byWorker[w] ? fmtPlain(summaryDetailRow.byWorker[w].actual) : "-"}
                      </td>
                    ))}
                    <td className="py-1.5 text-right font-mono tabular-nums text-stone-100 font-medium">
                      {summaryDetailRow.totalActual === null ? "-" : fmtPlain(summaryDetailRow.totalActual)}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-stone-500">{t("损耗", "Loss")}</td>
                    {SUMMARY_WORKERS.map((w) => {
                      const rec = summaryDetailRow.byWorker[w];
                      const over2 =
                        rec && rec.loss !== null && Math.abs(rec.loss) > LOSS_THRESHOLD;
                      return (
                        <td
                          key={w}
                          className={
                            "py-1.5 text-right font-mono tabular-nums " +
                            (!rec || rec.loss === null
                              ? "text-stone-600"
                              : over2
                              ? "text-rose-400"
                              : "text-emerald-400")
                          }
                        >
                          {rec && rec.loss !== null ? fmt(rec.loss) : "-"}
                        </td>
                      );
                    })}
                    <td
                      className={
                        "py-1.5 text-right font-mono tabular-nums font-medium " +
                        (summaryDetailRow.totalLoss === null
                          ? "text-stone-600"
                          : Math.abs(summaryDetailRow.totalLoss) > LOSS_THRESHOLD
                          ? "text-rose-400"
                          : "text-emerald-400")
                      }
                    >
                      {summaryDetailRow.totalLoss === null ? "-" : fmt(summaryDetailRow.totalLoss)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h4 className="text-xs font-medium text-stone-400 mb-2">
              {t("当天流水明细", "Flow entries for this day")}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {SUMMARY_WORKERS.map((w) => {
                const rec = summaryDetailRow.byWorker[w];
                return (
                  <div key={w} className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-400 font-medium mb-2">{w}</p>
                    {!rec ? (
                      <p className="text-xs text-stone-600">{t("这天没有记录", "No record this day")}</p>
                    ) : rec.transactions && rec.transactions.length > 0 ? (
                      <div className="divide-y divide-stone-900">
                        {rec.transactions.map((tx) => (
                          <div
                            key={tx.id}
                            className="flex items-center justify-between py-1.5 text-xs"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-stone-300 truncate">{tx.desc}</span>
                              {tx.dest && (
                                <span className="text-stone-600 bg-stone-900 rounded px-1.5 py-0.5 shrink-0">
                                  {tx.dest}
                                </span>
                              )}
                            </div>
                            <span
                              className={
                                "font-mono tabular-nums shrink-0 " +
                                (tx.amount > 0 ? "text-emerald-400" : "text-rose-400")
                              }
                            >
                              {fmt(tx.amount)} g
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-stone-600">
                        {t("这天没有流水（可能已归档清空）", "No flow entries (may have been archived)")}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
            disabled={exporting || !isAdmin || writeBlocked}
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
        {editableWorkers.map((w) => (
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

        {recentUnmatchedCount > 0 && (
          <div className="bg-rose-500/10 border border-rose-500/40 rounded-lg p-3 mb-3 text-xs text-rose-400 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {t(
              `最近2天有 ${recentUnmatchedCount} 笔转手记录还没配对，管理员可每周集中处理；正常流水录入不受影响`,
              `${recentUnmatchedCount} transfer entries from the last 2 days are unpaired. Admins can review them weekly; flow entry remains available.`
            )}
          </div>
        )}

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
                {d === "" ? t("去向/来源（必填）", "Destination/Source (required)") : d}
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

        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-stone-800">
          <span className="text-xs text-stone-500 shrink-0">{t("维修快捷录入：", "Repair quick entry:")}</span>
          <input
            type="number"
            step="0.01"
            placeholder={t("+/- 克", "+/- g")}
            value={repairAmount}
            onChange={(e) => setRepairAmount(e.target.value)}
            className="w-28 bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 font-mono"
          />
          <div className="flex rounded-lg border border-stone-700 overflow-hidden">
            {["JJ", "PD门市"].map((opt) => (
              <button
                key={opt}
                onClick={() => setRepairDest(opt)}
                className={
                  "px-3 py-2 text-sm " +
                  (repairDest === opt
                    ? "bg-amber-500 text-stone-950"
                    : "bg-stone-950 text-stone-400 hover:text-stone-200")
                }
              >
                {opt}
              </button>
            ))}
          </div>
          <button
            onClick={addRepairRow}
            className="flex items-center justify-center gap-1 bg-stone-800 hover:bg-stone-700 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100"
          >
            <Plus className="w-4 h-4" />
            {t("添加维修", "Add repair")}
          </button>
        </div>
        {repairError && <p className="text-xs text-rose-400 mt-2">{repairError}</p>}

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
          disabled={saving || writeBlocked || !editableWorkers.includes(activeWorker)}
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
                        {d === "" ? t("去向/来源（必填）", "Destination/Source (required)") : d}
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

                <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-stone-800">
                  <span className="text-xs text-stone-500 shrink-0">
                    {t("维修快捷录入：", "Repair quick entry:")}
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder={t("+/- 克", "+/- g")}
                    value={detailRepairAmount}
                    onChange={(e) => setDetailRepairAmount(e.target.value)}
                    className="w-28 bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 font-mono"
                  />
                  <div className="flex rounded-lg border border-stone-700 overflow-hidden">
                    {["JJ", "PD门市"].map((opt) => (
                      <button
                        key={opt}
                        onClick={() => setDetailRepairDest(opt)}
                        className={
                          "px-3 py-2 text-sm " +
                          (detailRepairDest === opt
                            ? "bg-amber-500 text-stone-950"
                            : "bg-stone-950 text-stone-400 hover:text-stone-200")
                        }
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={addDetailRepairRow}
                    className="flex items-center justify-center gap-1 bg-stone-800 hover:bg-stone-700 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100"
                  >
                    <Plus className="w-4 h-4" />
                    {t("添加维修", "Add repair")}
                  </button>
                </div>
                {detailRepairError && (
                  <p className="text-xs text-rose-400 mb-3">{detailRepairError}</p>
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
                  disabled={detailSaving || writeBlocked || !editableWorkers.includes(showDetail?.worker)}
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
                  {editableShipWorkers.map((w) => (
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
            <label className="flex items-center gap-2 mb-3 text-sm text-stone-300 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={shipIsCustomOrder}
                onChange={(e) => setShipIsCustomOrder(e.target.checked)}
                className="w-4 h-4 accent-amber-500"
              />
              {t(
                "这是订工（类别前面会加上「订工-」）",
                'This is a custom order (category will be prefixed with "订工-")'
              )}
            </label>
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
              denoms: DENOMINATIONS_GOLDBAR,
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
              denoms: DENOMINATIONS_GOLDBEAN,
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
                    {g.denoms.map((d) => (
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
                {g.label === "GOLDBAR"
                  ? t(
                      `1 DINAR 按 4.25g、1/2 DINAR 按 2.125g 计算；实重跟小计差超过${DENOM_TOLERANCE}g会标红，需要点确认才能保存。`,
                      `1 DINAR = 4.25g, 1/2 DINAR = 2.125g. A difference over ${DENOM_TOLERANCE}g between actual and subtotal is flagged and needs confirmation before saving.`
                    )
                  : t(
                      `实重跟小计差超过${DENOM_TOLERANCE}g会标红，需要点确认才能保存。`,
                      `A difference over ${DENOM_TOLERANCE}g between actual and subtotal is flagged and needs confirmation before saving.`
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
            disabled={shipSaving || writeBlocked || !editableShipWorkers.includes(shipFrom)}
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
                          disabled={!isAdmin}
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
                        disabled={!isAdmin}
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
                disabled={!isAdmin}
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
                              disabled={!isAdmin}
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
          <div className="flex justify-end mb-6">
                <button
                  onClick={refreshAll}
                  disabled={refreshingAll}
                  className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:text-stone-100 disabled:opacity-60"
                >
                  {refreshingAll ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <History className="w-3.5 h-3.5" />
                  )}
                  {t("刷新", "Refresh")}
                </button>
              </div>

              <div
                className={
                  "rounded-xl p-3 mb-6 border text-sm flex items-center gap-2 " +
                  (recentUnmatchedCount > 0
                    ? "bg-rose-500/10 border-rose-500/40 text-rose-400"
                    : "bg-stone-900 border-stone-800 text-stone-400")
                }
              >
                {recentUnmatchedCount > 0 && (
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                )}
                {t(
                  `最近2天未配对：${recentUnmatchedCount}——仅作提醒，不限制新增流水`,
                  `Unpaired in the last 2 days: ${recentUnmatchedCount} — reminder only; new entries remain available`
                )}
              </div>

              {(selectedOutgoingList.length > 0 || selectedIncomingList.length > 0) && (
                <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-4 mb-6">
                  <p className="text-sm text-stone-300 mb-2">
                    {t(
                      `已选 送出 ${selectedOutgoingList.length} 笔 → 接收 ${selectedIncomingList.length} 笔`,
                      `Selected: ${selectedOutgoingList.length} sent → ${selectedIncomingList.length} received`
                    )}
                  </p>
                  <div className="space-y-1 mb-3">
                    {selectedOutgoingList.map((i) => (
                      <p key={i.id} className="text-xs text-stone-500">
                        <span className="text-rose-400">↑</span> {i.worker} · {i.date} · {i.desc} ·{" "}
                        {fmtPlain(Math.abs(i.amount))}g
                      </p>
                    ))}
                    {selectedIncomingList.map((i) => (
                      <p key={i.id} className="text-xs text-stone-500">
                        <span className="text-emerald-400">↓</span> {i.worker} · {i.date} · {i.desc} ·{" "}
                        {fmtPlain(i.amount)}g
                      </p>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                      <p className="text-xs text-stone-500 mb-1">{t("送出合计", "Total sent")}</p>
                      <p className="font-mono tabular-nums text-stone-200">{fmtPlain(selTotalOut)} g</p>
                    </div>
                    <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                      <p className="text-xs text-stone-500 mb-1">{t("接收合计", "Total received")}</p>
                      <p className="font-mono tabular-nums text-stone-200">{fmtPlain(selTotalIn)} g</p>
                    </div>
                    <div
                      className={
                        "border rounded-lg p-3 " +
                        (Math.abs(selDiff) > (transferData.threshold ?? 0.05)
                          ? "bg-rose-500/10 border-rose-500/40"
                          : "bg-emerald-500/10 border-emerald-500/40")
                      }
                    >
                      <p className="text-xs text-stone-500 mb-1">{t("差异", "Diff")}</p>
                      <p
                        className={
                          "font-mono tabular-nums " +
                          (Math.abs(selDiff) > (transferData.threshold ?? 0.05)
                            ? "text-rose-400"
                            : "text-emerald-400")
                        }
                      >
                        {fmt(selDiff)} g
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={confirmMatch}
                      disabled={
                        matchSaving || selectedOutgoingList.length === 0 || selectedIncomingList.length === 0
                      }
                      className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-4 py-2 text-sm"
                    >
                      {matchSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4" />
                      )}
                      {t("确认配对", "Confirm pairing")}
                    </button>
                    <button
                      onClick={() => {
                        setSelectedOutgoingKeys(new Set());
                        setSelectedIncomingKeys(new Set());
                      }}
                      className="text-xs px-3 py-2 rounded-lg text-stone-500 hover:text-stone-300"
                    >
                      {t("取消选择", "Clear selection")}
                    </button>
                  </div>
                </div>
              )}
              {matchMsg && <p className="text-xs text-stone-400 mb-4">{matchMsg}</p>}

              <div className="grid md:grid-cols-2 gap-4 mb-6">
                <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
                  <h2 className="text-sm font-medium text-stone-300 mb-3">
                    {t(`待配对 · 送出（${outgoingItems.length}）`, `Unpaired · Sent (${outgoingItems.length})`)}
                  </h2>
                  {outgoingItems.length === 0 ? (
                    <p className="text-sm text-stone-600 py-4 text-center">
                      {t("没有待配对的送出记录", "No unpaired outgoing entries")}
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {outgoingItems.map((item) => {
                        const key = itemKey(item);
                        const selected = selectedOutgoingKeys.has(key);
                        return (
                          <div
                            key={key}
                            className={
                              "flex items-stretch gap-1 rounded-lg border transition-colors " +
                              (selected
                                ? "bg-amber-500/10 border-amber-500/50"
                                : "bg-stone-950 border-stone-800 hover:border-stone-700")
                            }
                          >
                            <button
                              onClick={() => toggleOutgoing(key)}
                              className="flex items-center gap-3 flex-1 min-w-0 text-left p-3"
                            >
                              <span
                                className={
                                  "shrink-0 w-4 h-4 rounded border flex items-center justify-center " +
                                  (selected
                                    ? "bg-amber-500 border-amber-500"
                                    : "border-stone-600")
                                }
                              >
                                {selected && <CheckCircle2 className="w-3.5 h-3.5 text-stone-950" />}
                              </span>
                              <span className="flex-1 min-w-0">
                                <div className="flex items-center justify-between text-sm">
                                  <span className="text-stone-300">{item.worker}</span>
                                  <span className="font-mono tabular-nums text-rose-400">
                                    {fmt(item.amount)} g
                                  </span>
                                </div>
                                <p className="text-xs text-stone-500 mt-0.5 truncate">
                                  {item.date} · {item.desc} → {item.dest}
                                </p>
                              </span>
                            </button>
                            <button
                              onClick={() => deleteUnmatchedItem(item)}
                              className="shrink-0 px-3 flex items-center text-stone-600 hover:text-rose-400"
                              aria-label={t("删除这条记录", "Delete this entry")}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
                  <h2 className="text-sm font-medium text-stone-300 mb-3">
                    {t(`待配对 · 接收（${incomingItems.length}）`, `Unpaired · Received (${incomingItems.length})`)}
                  </h2>
                  {incomingItems.length === 0 ? (
                    <p className="text-sm text-stone-600 py-4 text-center">
                      {t("没有待配对的接收记录", "No unpaired incoming entries")}
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {incomingItems.map((item) => {
                        const key = itemKey(item);
                        const selected = selectedIncomingKeys.has(key);
                        return (
                          <div
                            key={key}
                            className={
                              "flex items-stretch gap-1 rounded-lg border transition-colors " +
                              (selected
                                ? "bg-amber-500/10 border-amber-500/50"
                                : "bg-stone-950 border-stone-800 hover:border-stone-700")
                            }
                          >
                            <button
                              onClick={() => toggleIncoming(key)}
                              className="flex items-center gap-3 flex-1 min-w-0 text-left p-3"
                            >
                              <span
                                className={
                                  "shrink-0 w-4 h-4 rounded border flex items-center justify-center " +
                                  (selected
                                    ? "bg-amber-500 border-amber-500"
                                    : "border-stone-600")
                                }
                              >
                                {selected && <CheckCircle2 className="w-3.5 h-3.5 text-stone-950" />}
                              </span>
                              <span className="flex-1 min-w-0">
                                <div className="flex items-center justify-between text-sm">
                                  <span className="text-stone-300">{item.worker}</span>
                                  <span className="font-mono tabular-nums text-emerald-400">
                                    {fmt(item.amount)} g
                                  </span>
                                </div>
                                <p className="text-xs text-stone-500 mt-0.5 truncate">
                                  {item.date} · {item.desc} ← {item.dest}
                                </p>
                              </span>
                            </button>
                            <button
                              onClick={() => deleteUnmatchedItem(item)}
                              className="shrink-0 px-3 flex items-center text-stone-600 hover:text-rose-400"
                              aria-label={t("删除这条记录", "Delete this entry")}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
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
                    disabled={!isAdmin}
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
                  {t(`已配对（${matchRecords.length}）`, `Paired (${matchRecords.length})`)}
                </h2>
                {matchRecords.length === 0 ? (
                  <p className="text-sm text-stone-600 py-4 text-center">
                    {t("还没有配对记录", "No pairings yet")}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {[...matchRecords]
                      .sort((a, b) => (b.matchedAt || "").localeCompare(a.matchedAt || ""))
                      .map((r) => {
                        const outList = getOutgoingList(r);
                        const inList = getIncomingList(r);
                        const totalOut = getTotalOut(r);
                        const totalIn = getTotalIn(r);
                        const over = Math.abs(r.diff) > (transferData.threshold ?? 0.05);
                        return (
                          <div
                            key={r.id}
                            className="bg-stone-950 border border-stone-800 rounded-lg p-3"
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="text-xs text-stone-500 space-y-0.5 min-w-0">
                                {outList.map((i, idx) => (
                                  <p key={idx} className="truncate">
                                    <span className="text-rose-400">↑</span> {i.worker} · {i.date} ·{" "}
                                    {i.desc} · {fmtPlain(Math.abs(i.amount))}g
                                  </p>
                                ))}
                                {inList.map((i, idx) => (
                                  <p key={idx} className="truncate">
                                    <span className="text-emerald-400">↓</span> {i.worker} · {i.date} ·{" "}
                                    {i.desc} · {fmtPlain(i.amount)}g
                                  </p>
                                ))}
                              </div>
                              <button
                                onClick={() => unmatch(r)}
                                className="shrink-0 text-stone-600 hover:text-rose-400 p-2 -m-2 rounded-lg active:bg-stone-800"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                            <div className="flex items-center gap-4 text-sm">
                              <span className="text-stone-400">
                                {t("送出合计", "Total sent")}{" "}
                                <span className="font-mono tabular-nums text-stone-200">
                                  {fmtPlain(totalOut)}
                                </span>
                              </span>
                              <span className="text-stone-400">
                                {t("接收合计", "Total received")}{" "}
                                <span className="font-mono tabular-nums text-stone-200">
                                  {fmtPlain(totalIn)}
                                </span>
                              </span>
                              <span
                                className={
                                  "font-mono tabular-nums inline-flex items-center gap-1 " +
                                  (over ? "text-rose-400" : "text-emerald-400")
                                }
                              >
                                {over && <AlertTriangle className="w-3 h-3" />}
                                {t("差异", "Diff")} {fmt(r.diff)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
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
      </fieldset>
    </div>
  );
}
