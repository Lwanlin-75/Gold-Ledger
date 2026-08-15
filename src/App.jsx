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
} from "lucide-react";

const WORKERS = ["JJ", "PD Lv2", "PD Lv1", "倒模", "Lv1倒模车花"];
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

const SPECIAL_KEYS = { SHIPMENTS: "__SHIPMENTS__", TRANSFERS: "__TRANSFERS__" };
const SHIP_CATEGORIES = ["戒指", "链", "牌", "GOLDBAR", "GOLDBEAN", "OTHER"];
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
const TRANSFER_TYPES = ["掉色来回", "Lv1↔Lv2上下楼", "OTHER"];

const emptyShipmentData = () => ({ history: [] });
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

const emptyWorkerData = () => ({ lastWeight: null, history: [] });

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
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [data, setData] = useState(() =>
    Object.fromEntries(WORKERS.map((w) => [w, emptyWorkerData()]))
  );
  const [activeWorker, setActiveWorker] = useState(WORKERS[0]);
  const [drafts, setDrafts] = useState(() =>
    Object.fromEntries(WORKERS.map((w) => [w, []]))
  );
  const [descInput, setDescInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [destInput, setDestInput] = useState("");
  const [rowError, setRowError] = useState("");
  const [actualInput, setActualInput] = useState("");
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
  const [shipDate, setShipDate] = useState(todayStr());
  const [shipCategory, setShipCategory] = useState(SHIP_CATEGORIES[0]);
  const [shipCategoryCustom, setShipCategoryCustom] = useState("");
  const [shipWeight, setShipWeight] = useState("");
  const [shipItems, setShipItems] = useState([]);
  const [shipRowError, setShipRowError] = useState("");
  const [goldbarQty, setGoldbarQty] = useState({});
  const [goldbeanQty, setGoldbeanQty] = useState({});
  const [shipSaving, setShipSaving] = useState(false);
  const [shipMsg, setShipMsg] = useState("");

  // 转手核对
  const [transferData, setTransferData] = useState(emptyTransferData());
  const [thresholdDraft, setThresholdDraft] = useState("0.05");
  const [transDate, setTransDate] = useState(todayStr());
  const [transType, setTransType] = useState(TRANSFER_TYPES[0]);
  const [transTypeCustom, setTransTypeCustom] = useState("");
  const [transDesc, setTransDesc] = useState("");
  const [transSent, setTransSent] = useState("");
  const [transReceived, setTransReceived] = useState("");
  const [transError, setTransError] = useState("");
  const [transSaving, setTransSaving] = useState(false);
  const [transMsg, setTransMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const allKeys = [...WORKERS, SPECIAL_KEYS.SHIPMENTS, SPECIAL_KEYS.TRANSFERS];
      const { data: rows, error } = await supabase
        .from("gold_ledger")
        .select("worker, data")
        .in("worker", allKeys);
      if (error) throw error;
      const next = Object.fromEntries(WORKERS.map((w) => [w, emptyWorkerData()]));
      let nextShipments = emptyShipmentData();
      let nextTransfers = emptyTransferData();
      for (const row of rows || []) {
        if (row.worker === SPECIAL_KEYS.SHIPMENTS) {
          nextShipments = row.data || emptyShipmentData();
        } else if (row.worker === SPECIAL_KEYS.TRANSFERS) {
          nextTransfers = row.data || emptyTransferData();
        } else {
          next[row.worker] = row.data || emptyWorkerData();
        }
      }
      if (!cancelled) {
        setData(next);
        setShipmentData(nextShipments);
        setTransferData(nextTransfers);
        setThresholdDraft(String(nextTransfers.threshold ?? 0.05));
        setReady(true);
      }
    }
    load().catch(() => {
      if (!cancelled) {
        setLoadError("读取记录失败（检查网络或Supabase配置），先从空白开始，保存时会重试。");
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const cur = data[activeWorker] || emptyWorkerData();
  const curDraft = drafts[activeWorker] || [];
  const totalChange = useMemo(
    () => curDraft.reduce((s, t) => s + t.amount, 0),
    [curDraft]
  );
  const hasBaseline = cur.lastWeight !== null;
  const expected = hasBaseline ? cur.lastWeight + totalChange : null;
  const destinations = useMemo(() => destinationsFor(activeWorker), [activeWorker]);

  const actualNum = actualInput === "" ? null : parseFloat(actualInput);
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
    setDrafts((d) => ({
      ...d,
      [activeWorker]: [
        ...(d[activeWorker] || []),
        { id: Date.now() + Math.random(), desc: descInput.trim(), amount: amt, dest: destInput },
      ],
    }));
    setDescInput("");
    setAmountInput("");
    setDestInput("");
    setRowError("");
  }

  function removeRow(id) {
    setDrafts((d) => ({
      ...d,
      [activeWorker]: (d[activeWorker] || []).filter((t) => t.id !== id),
    }));
  }

  async function persistRow(key, nextData) {
    const { error } = await supabase
      .from("gold_ledger")
      .upsert(
        {
          worker: key,
          data: nextData,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "worker" }
      );
    if (error) throw error;
  }
  const persistWorker = persistRow;

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

  async function saveShipment() {
    setShipMsg("");
    const goldbarTotal = denomTotal(goldbarQty);
    const goldbeanTotal = denomTotal(goldbeanQty);
    const hasDenom = goldbarTotal > 0 || goldbeanTotal > 0;
    if (shipItems.length === 0 && !hasDenom) {
      setShipMsg("请至少添加一项出货记录");
      return;
    }
    setShipSaving(true);
    const items = [...shipItems];
    if (goldbarTotal > 0) {
      items.push({
        id: Date.now() + Math.random(),
        category: "GOLDBAR",
        weight: Math.round(goldbarTotal * 100) / 100,
      });
    }
    if (goldbeanTotal > 0) {
      items.push({
        id: Date.now() + Math.random(),
        category: "GOLDBEAN",
        weight: Math.round(goldbeanTotal * 100) / 100,
      });
    }
    const record = {
      id: Date.now() + Math.random(),
      date: shipDate,
      items,
      denom: { goldbar: { ...goldbarQty }, goldbean: { ...goldbeanQty } },
    };
    const nextData = { history: [...shipmentData.history, record] };
    try {
      await persistRow(SPECIAL_KEYS.SHIPMENTS, nextData);
      setShipmentData(nextData);
      setShipItems([]);
      setGoldbarQty({});
      setGoldbeanQty({});
      setShipDate(todayStr());
      setShipMsg("已保存这次出货记录");
    } catch {
      setShipMsg("保存失败，检查网络后重试");
    } finally {
      setShipSaving(false);
    }
  }

  async function deleteShipmentRecord(id) {
    if (!window.confirm("确定删除这条出货记录？")) return;
    const nextData = { history: shipmentData.history.filter((r) => r.id !== id) };
    try {
      await persistRow(SPECIAL_KEYS.SHIPMENTS, nextData);
      setShipmentData(nextData);
    } catch {
      setShipMsg("删除失败，检查网络后重试");
    }
  }

  const shipCategories = useMemo(() => {
    const set = new Set(["戒指", "链", "牌", "GOLDBAR", "GOLDBEAN"]);
    shipmentData.history.forEach((r) => r.items.forEach((i) => set.add(i.category)));
    return Array.from(set);
  }, [shipmentData.history]);

  const shipRowsSorted = useMemo(
    () => [...shipmentData.history].sort((a, b) => b.date.localeCompare(a.date)),
    [shipmentData.history]
  );

  // ---- 转手核对 ----
  async function saveThreshold() {
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

  async function saveTransfer() {
    setTransError("");
    setTransMsg("");
    const type = transType === "OTHER" ? transTypeCustom.trim() : transType;
    const sent = parseFloat(transSent);
    const received = parseFloat(transReceived);
    if (!type) {
      setTransError("请填写类型");
      return;
    }
    if (transSent === "" || Number.isNaN(sent)) {
      setTransError("请填写送出方重量");
      return;
    }
    if (transReceived === "" || Number.isNaN(received)) {
      setTransError("请填写接收方重量");
      return;
    }
    setTransSaving(true);
    const record = {
      id: Date.now() + Math.random(),
      date: transDate,
      type,
      desc: transDesc.trim(),
      sent,
      received,
      diff: received - sent,
    };
    const nextData = { ...transferData, history: [...transferData.history, record] };
    try {
      await persistRow(SPECIAL_KEYS.TRANSFERS, nextData);
      setTransferData(nextData);
      setTransDesc("");
      setTransSent("");
      setTransReceived("");
      setTransTypeCustom("");
      setTransDate(todayStr());
      setTransMsg("已保存");
    } catch {
      setTransMsg("保存失败，检查网络后重试");
    } finally {
      setTransSaving(false);
    }
  }

  async function deleteTransferRecord(id) {
    if (!window.confirm("确定删除这条记录？")) return;
    const nextData = {
      ...transferData,
      history: transferData.history.filter((r) => r.id !== id),
    };
    try {
      await persistRow(SPECIAL_KEYS.TRANSFERS, nextData);
      setTransferData(nextData);
    } catch {
      setTransMsg("删除失败，检查网络后重试");
    }
  }

  const transRowsSorted = useMemo(
    () => [...transferData.history].sort((a, b) => b.date.localeCompare(a.date)),
    [transferData.history]
  );

  async function saveDay() {
    setActualError("");
    setSaveMsg("");
    if (actualInput === "" || Number.isNaN(actualNum)) {
      setActualError("请填写这一天过秤读到的实重");
      return;
    }
    setSaving(true);
    const rawRecord = {
      date: dateInput,
      transactions: curDraft,
      actual: actualNum,
      exported: false,
    };
    const newHistory = recomputeChain([...cur.history, rawRecord]);
    const nextWorkerData = { lastWeight: actualNum, history: newHistory };
    try {
      await persistWorker(activeWorker, nextWorkerData);
      setData((d) => ({ ...d, [activeWorker]: nextWorkerData }));
      setDrafts((d) => ({ ...d, [activeWorker]: [] }));
      setActualInput("");
      setDateInput(todayStr());
      setSaveMsg("已保存这一天的记录");
    } catch {
      setSaveMsg("保存失败，检查网络或Supabase配置，请重试一次");
    } finally {
      setSaving(false);
    }
  }

  async function undoLastDay() {
    if (cur.history.length === 0) return;
    setUndoing(true);
    const newHistory = recomputeChain(cur.history.slice(0, -1));
    const prevWeight =
      newHistory.length > 0 ? newHistory[newHistory.length - 1].actual : null;
    const nextWorkerData = { lastWeight: prevWeight, history: newHistory };
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
    if (!showDetail) return;
    const { worker, index } = showDetail;
    const record = data[worker].history[index];
    if (record.exported) return;
    const num = parseFloat(editActual);
    if (editActual === "" || Number.isNaN(num)) {
      setDetailError("请填写有效的实重");
      return;
    }
    setDetailSaving(true);
    const newHistoryRaw = [...data[worker].history];
    newHistoryRaw[index] = {
      ...newHistoryRaw[index],
      transactions: editTransactions,
      actual: num,
    };
    const newHistory = recomputeChain(newHistoryRaw);
    const lastWeight = newHistory.length
      ? newHistory[newHistory.length - 1].actual
      : null;
    const nextWorkerData = { lastWeight, history: newHistory };
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
          const nextWorkerData = { lastWeight: data[w].lastWeight, history: newHist };
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

  if (!ready) {
    return (
      <div className="min-h-[300px] flex items-center justify-center text-stone-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        正在加载记录…
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
      <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <Scale className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-stone-100 tracking-wide">
              金重对账
            </h1>
            <p className="text-xs text-stone-500">每天过秤，自动算损耗</p>
          </div>
        </div>
        {loadError && (
          <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-1.5">
            {loadError}
          </div>
        )}
      </div>

      <div className="flex gap-2 mb-6">
        {[
          { key: "workers", label: "对账", icon: Scale },
          { key: "shipments", label: "出货记录", icon: Truck },
          { key: "transfers", label: "转手核对", icon: ArrowLeftRight },
        ].map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={
              "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors " +
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
          导出与归档（全部worker）
        </h2>
        <p className="text-xs text-stone-500 mb-3">
          还有 {pendingCount.days} 天、{pendingCount.lines} 条流水未导出。建议每7天导出一次备份。
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
            导出Excel
          </button>
          {pendingExportKeys && (
            <>
              {confirmClear ? (
                <>
                  <span className="text-xs text-rose-400">
                    确定清空这批明细？（汇总数字会保留）
                  </span>
                  <button
                    onClick={handleClearExported}
                    disabled={clearing}
                    className="text-xs px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/40 text-rose-400 disabled:opacity-60"
                  >
                    {clearing ? "清空中…" : "确认清空"}
                  </button>
                  <button
                    onClick={() => setConfirmClear(false)}
                    className="text-xs px-3 py-1.5 rounded-lg text-stone-500 hover:text-stone-300"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-400 hover:text-stone-200"
                >
                  清空已导出明细
                </button>
              )}
            </>
          )}
        </div>
        {exportMsg && <p className="text-xs text-stone-400 mt-2">{exportMsg}</p>}
      </div>

      <div className="flex gap-2 mb-6 border-b border-stone-800 pb-3">
        {WORKERS.map((w) => (
          <button
            key={w}
            onClick={() => setActiveWorker(w)}
            className={
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors " +
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
          正在录入哪一天的数据？
        </label>
        <input
          type="date"
          value={dateInput}
          onChange={(e) => setDateInput(e.target.value)}
          className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
        />
        <p className="text-xs text-stone-500 mt-2">
          下面的流水和实重都会记在这个日期上。补录以前的数据时，请从最早的一天开始，按顺序一天天存完再存下一天。
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <p className="text-xs text-stone-500 mb-1">上次实重</p>
          <p className="text-xl font-mono tabular-nums text-stone-100">
            {hasBaseline ? fmtPlain(cur.lastWeight) + " g" : "尚未设置"}
          </p>
        </div>
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <p className="text-xs text-stone-500 mb-1">今日变动合计</p>
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
          <p className="text-xs text-stone-500 mb-1">历史累计损耗</p>
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
          还没有 {activeWorker} 的期初实重，先在下面填入这一天过秤的重量作为起点，之后就能自动算损耗了。
        </div>
      )}

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
        <h2 className="text-sm font-medium text-stone-300 mb-3">
          {dateInput} 流水（{activeWorker}）
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_130px_auto] gap-2 mb-2">
          <input
            type="text"
            placeholder="描述，例如：出 老板-999料"
            value={descInput}
            onChange={(e) => setDescInput(e.target.value)}
            className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
          />
          <input
            type="number"
            step="0.01"
            placeholder="+/- 克"
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
                {d === "" ? "去向（可选）" : d}
              </option>
            ))}
          </select>
          <button
            onClick={addRow}
            className="flex items-center justify-center gap-1 bg-stone-800 hover:bg-stone-700 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100"
          >
            <Plus className="w-4 h-4" />
            添加
          </button>
        </div>
        {rowError && <p className="text-xs text-rose-400 mb-2">{rowError}</p>}

        {curDraft.length === 0 ? (
          <p className="text-sm text-stone-600 py-4 text-center">
            这一天还没有记录任何加减
          </p>
        ) : (
          <div className="divide-y divide-stone-800 border-t border-stone-800 mt-2">
            {curDraft.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between py-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-stone-300 truncate">{t.desc}</span>
                  {t.dest && (
                    <span className="text-xs text-stone-500 bg-stone-800 rounded px-2 py-0.5 shrink-0">
                      {t.dest}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={
                      "font-mono tabular-nums " +
                      (t.amount > 0 ? "text-emerald-400" : "text-rose-400")
                    }
                  >
                    {fmt(t.amount)} g
                  </span>
                  <button
                    onClick={() => removeRow(t.id)}
                    aria-label="删除这条记录"
                    className="text-stone-600 hover:text-rose-400"
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
        <h2 className="text-sm font-medium text-stone-300 mb-3">过秤结算</h2>

        <div>
          <label className="block text-xs text-stone-500 mb-1">
            实重（{dateInput} 过秤读数，克）
          </label>
          <input
            type="number"
            step="0.01"
            placeholder="从秤上读到的数字"
            value={actualInput}
            onChange={(e) => setActualInput(e.target.value)}
            className="w-full md:w-72 bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-lg font-mono tabular-nums text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
          />
        </div>
        {actualError && (
          <p className="text-xs text-rose-400 mt-2">{actualError}</p>
        )}

        {hasBaseline && (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
              <p className="text-xs text-stone-500 mb-1">要有</p>
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
                损耗
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
                {loss === null ? "填入实重后显示" : fmt(loss) + " g"}
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
          保存这一天
        </button>
        {saveMsg && (
          <p className="text-xs text-stone-400 mt-2">{saveMsg}</p>
        )}
      </div>

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-stone-300 flex items-center gap-2">
            <History className="w-4 h-4" />
            历史记录（最近 {recentHistory.length} 天，点日期看详情）
          </h2>
          {cur.history.length > 0 && (
            <div className="flex items-center gap-2">
              {confirmUndo && (
                <span className="text-xs text-rose-400">确定撤销最近一天？</span>
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
                  ? "撤销中…"
                  : confirmUndo
                  ? "确认撤销"
                  : "撤销最近一天"}
              </button>
              {confirmUndo && (
                <button
                  onClick={() => setConfirmUndo(false)}
                  className="text-xs px-3 py-1.5 rounded-lg text-stone-500 hover:text-stone-300"
                >
                  取消
                </button>
              )}
            </div>
          )}
        </div>
        {recentHistory.length === 0 ? (
          <p className="text-sm text-stone-600 py-4 text-center">
            还没有历史记录
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-stone-500 border-b border-stone-800">
                  <th className="text-left py-2 font-normal">日期</th>
                  <th className="text-right py-2 font-normal">要有</th>
                  <th className="text-right py-2 font-normal">实重</th>
                  <th className="text-right py-2 font-normal">损耗</th>
                  <th className="text-right py-2 font-normal">趋势</th>
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
            className="bg-stone-900 border border-stone-700 rounded-2xl p-5 md:p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-stone-200">
                {showDetail.worker} · {detailRecord.date}
              </h3>
              <button
                onClick={closeDetail}
                className="text-stone-500 hover:text-stone-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {detailRecord.exported ? (
              <div>
                <div className="flex items-center gap-2 text-xs text-stone-500 bg-stone-800 rounded-lg px-3 py-2 mb-4">
                  <Lock className="w-3.5 h-3.5" />
                  这天的流水明细已经导出并清空，只能查看汇总，无法再编辑。
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">要有</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {fmtPlain(detailRecord.expected)} g
                    </p>
                  </div>
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">实重</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {fmtPlain(detailRecord.actual)} g
                    </p>
                  </div>
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">损耗</p>
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
                    placeholder="描述"
                    value={detailDesc}
                    onChange={(e) => setDetailDesc(e.target.value)}
                    className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
                  />
                  <input
                    type="number"
                    step="0.01"
                    placeholder="+/- 克"
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
                        {d === "" ? "去向" : d}
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
                    这一天没有流水记录
                  </p>
                ) : (
                  <div className="divide-y divide-stone-800 border-t border-stone-800 mb-4">
                    {editTransactions.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between py-2 text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-stone-300 truncate">{t.desc}</span>
                          {t.dest && (
                            <span className="text-xs text-stone-500 bg-stone-800 rounded px-2 py-0.5 shrink-0">
                              {t.dest}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span
                            className={
                              "font-mono tabular-nums " +
                              (t.amount > 0 ? "text-emerald-400" : "text-rose-400")
                            }
                          >
                            {fmt(t.amount)} g
                          </span>
                          <button
                            onClick={() => removeDetailRow(t.id)}
                            className="text-stone-600 hover:text-rose-400"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <label className="block text-xs text-stone-500 mb-1">
                  实重（克）
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={editActual}
                  onChange={(e) => setEditActual(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-lg font-mono tabular-nums text-stone-100 focus:outline-none focus:border-amber-500 mb-3"
                />

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">要有（预览）</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {detailExpected === null ? "-" : fmtPlain(detailExpected)} g
                    </p>
                  </div>
                  <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                    <p className="text-xs text-stone-500 mb-1">损耗（预览）</p>
                    <p className="font-mono tabular-nums text-stone-200">
                      {detailLoss === null ? "-" : fmt(detailLoss)} g
                    </p>
                  </div>
                </div>

                <p className="text-xs text-stone-600 mb-3">
                  保存后会自动重新计算这天之后每一天的"要有"和"损耗"。
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
                  保存修改
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
            <label className="block text-xs text-amber-400/80 mb-1 font-medium">
              出货日期
            </label>
            <input
              type="date"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
              className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              其他类别出货（戒指 / 链 / 牌 / 自定义）
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-[130px_1fr_120px_auto] gap-2 mb-2">
              <select
                value={shipCategory}
                onChange={(e) => setShipCategory(e.target.value)}
                className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
              >
                {SHIP_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c === "OTHER" ? "自定义…" : c}
                  </option>
                ))}
              </select>
              {shipCategory === "OTHER" && (
                <input
                  type="text"
                  placeholder="类别名称"
                  value={shipCategoryCustom}
                  onChange={(e) => setShipCategoryCustom(e.target.value)}
                  className="bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
                />
              )}
              <input
                type="number"
                step="0.01"
                placeholder="重量(g)"
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
                添加
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
                        className="text-stone-600 hover:text-rose-400"
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
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              GOLDBAR / GOLDBEAN 出货数量
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-stone-500 border-b border-stone-800">
                    <th className="text-left py-2 font-normal">面额</th>
                    <th className="text-right py-2 font-normal w-28">GOLDBAR</th>
                    <th className="text-right py-2 font-normal w-28">GOLDBEAN</th>
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
                          value={goldbarQty[d.key] || ""}
                          onChange={(e) =>
                            setGoldbarQty((q) => ({ ...q, [d.key]: e.target.value }))
                          }
                          className="w-full bg-stone-950 border border-stone-700 rounded-lg px-2 py-1 text-sm text-right text-stone-100 font-mono focus:outline-none focus:border-amber-500"
                        />
                      </td>
                      <td className="py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={goldbeanQty[d.key] || ""}
                          onChange={(e) =>
                            setGoldbeanQty((q) => ({ ...q, [d.key]: e.target.value }))
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
                <p className="text-xs text-stone-500 mb-1">GOLDBAR 小计</p>
                <p className="font-mono tabular-nums text-stone-200">
                  {fmtPlain(denomTotal(goldbarQty))} g
                </p>
              </div>
              <div className="bg-stone-950 border border-stone-800 rounded-lg p-3">
                <p className="text-xs text-stone-500 mb-1">GOLDBEAN 小计</p>
                <p className="font-mono tabular-nums text-stone-200">
                  {fmtPlain(denomTotal(goldbeanQty))} g
                </p>
              </div>
            </div>
            <p className="text-xs text-stone-600 mt-2">
              1 DINAR 按 4.25g、1/2 DINAR 按 2.125g 计算，如果你们用的金币重量不一样，告诉我调整。
            </p>
          </div>

          <button
            onClick={saveShipment}
            disabled={shipSaving}
            className="mb-6 w-full md:w-auto flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
          >
            {shipSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            保存这次出货
          </button>
          {shipMsg && <p className="text-xs text-stone-400 -mt-4 mb-6">{shipMsg}</p>}

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
            <h2 className="text-sm font-medium text-stone-300 mb-3 flex items-center gap-2">
              <Truck className="w-4 h-4" />
              出货记录（按日期，每行一次出货）
            </h2>
            {shipRowsSorted.length === 0 ? (
              <p className="text-sm text-stone-600 py-4 text-center">
                还没有出货记录
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-stone-500 border-b border-stone-800">
                      <th className="text-left py-2 font-normal">日期</th>
                      {shipCategories.map((c) => (
                        <th key={c} className="text-right py-2 font-normal">
                          {c}
                        </th>
                      ))}
                      <th className="text-right py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800">
                    {shipRowsSorted.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 text-stone-400">{r.date}</td>
                        {shipCategories.map((c) => {
                          const w = r.items
                            .filter((i) => i.category === c)
                            .reduce((s, i) => s + i.weight, 0);
                          return (
                            <td
                              key={c}
                              className="py-2 text-right font-mono tabular-nums text-stone-100"
                            >
                              {w > 0 ? fmtPlain(w) : "-"}
                            </td>
                          );
                        })}
                        <td className="py-2 text-right">
                          <button
                            onClick={() => deleteShipmentRecord(r.id)}
                            className="text-stone-600 hover:text-rose-400"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
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
            <h2 className="text-sm font-medium text-stone-300 mb-3">
              新增一笔核对（送出方 vs 接收方）
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">日期</label>
                <input
                  type="date"
                  value={transDate}
                  onChange={(e) => setTransDate(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">类型</label>
                <select
                  value={transType}
                  onChange={(e) => setTransType(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
                >
                  {TRANSFER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t === "OTHER" ? "自定义…" : t}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {transType === "OTHER" && (
              <input
                type="text"
                placeholder="自定义类型名称"
                value={transTypeCustom}
                onChange={(e) => setTransTypeCustom(e.target.value)}
                className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 mb-3"
              />
            )}
            <input
              type="text"
              placeholder="备注（可选，例如：戒指一批）"
              value={transDesc}
              onChange={(e) => setTransDesc(e.target.value)}
              className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500 mb-3"
            />
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">送出方重量(g)</label>
                <input
                  type="number"
                  step="0.01"
                  value={transSent}
                  onChange={(e) => setTransSent(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">接收方重量(g)</label>
                <input
                  type="number"
                  step="0.01"
                  value={transReceived}
                  onChange={(e) => setTransReceived(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm font-mono text-stone-100 focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>
            {transError && (
              <p className="text-xs text-rose-400 mb-2">{transError}</p>
            )}
            <button
              onClick={saveTransfer}
              disabled={transSaving}
              className="flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 font-medium rounded-lg px-5 py-2.5 text-sm"
            >
              {transSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              保存这笔核对
            </button>
            {transMsg && <p className="text-xs text-stone-400 mt-2">{transMsg}</p>}
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
            <label className="block text-xs text-stone-500 mb-1">
              误差标红阈值（超过这个数就标红，克）
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
                更新阈值
              </button>
              <span className="text-xs text-stone-600">
                当前生效：{fmtPlain(transferData.threshold ?? 0.05)} g
              </span>
            </div>
          </div>

          <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
            <h2 className="text-sm font-medium text-stone-300 mb-3 flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4" />
              核对记录
            </h2>
            {transRowsSorted.length === 0 ? (
              <p className="text-sm text-stone-600 py-4 text-center">
                还没有核对记录
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-stone-500 border-b border-stone-800">
                      <th className="text-left py-2 font-normal">日期</th>
                      <th className="text-left py-2 font-normal">类型</th>
                      <th className="text-left py-2 font-normal">备注</th>
                      <th className="text-right py-2 font-normal">送出</th>
                      <th className="text-right py-2 font-normal">接收</th>
                      <th className="text-right py-2 font-normal">差异</th>
                      <th className="text-right py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800">
                    {transRowsSorted.map((r) => {
                      const over =
                        Math.abs(r.diff) > (transferData.threshold ?? 0.05);
                      return (
                        <tr key={r.id}>
                          <td className="py-2 text-stone-400">{r.date}</td>
                          <td className="py-2 text-stone-300">{r.type}</td>
                          <td className="py-2 text-stone-500">{r.desc || "-"}</td>
                          <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                            {fmtPlain(r.sent)}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-stone-300">
                            {fmtPlain(r.received)}
                          </td>
                          <td
                            className={
                              "py-2 text-right font-mono tabular-nums flex items-center justify-end gap-1 " +
                              (over ? "text-rose-400" : "text-emerald-400")
                            }
                          >
                            {over && <AlertTriangle className="w-3 h-3" />}
                            {fmt(r.diff)}
                          </td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => deleteTransferRecord(r.id)}
                              className="text-stone-600 hover:text-rose-400"
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
    </div>
  );
}
