import { useState, useEffect, useMemo } from "react";
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
} from "lucide-react";

const WORKERS = ["JJ", "PD Lv2", "PD Lv1", "倒模", "Lv1倒模车花"];
const DESTINATIONS = [
  "",
  "老板",
  "现货",
  "PD门市",
  "JJ门市",
  "倒模",
  "TUN/ABAD",
  "REPAIR",
  "JJ↔PD Lv2",
  "OTHER",
];
const LOSS_THRESHOLD = 1; // 克，超过这个数就标红提醒

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

const emptyWorkerData = () => ({ lastWeight: null, history: [] });

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data: rows, error } = await supabase
        .from("gold_ledger")
        .select("worker, data")
        .in("worker", WORKERS);
      if (error) throw error;
      const next = Object.fromEntries(WORKERS.map((w) => [w, emptyWorkerData()]));
      for (const row of rows || []) {
        next[row.worker] = row.data || emptyWorkerData();
      }
      if (!cancelled) {
        setData(next);
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

  async function saveDay() {
    setActualError("");
    setSaveMsg("");
    if (actualInput === "" || Number.isNaN(actualNum)) {
      setActualError("请填写今天过秤读到的实重");
      return;
    }
    setSaving(true);
    const record = {
      date: dateInput,
      prevWeight: cur.lastWeight,
      transactions: curDraft,
      total: totalChange,
      expected: hasBaseline ? expected : null,
      actual: actualNum,
      loss: hasBaseline ? actualNum - expected : null,
    };
    const nextWorkerData = {
      lastWeight: actualNum,
      history: [...cur.history, record],
    };
    try {
      const { error } = await supabase
        .from("gold_ledger")
        .upsert(
          {
            worker: activeWorker,
            data: nextWorkerData,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "worker" }
        );
      if (error) throw error;
      setData((d) => ({ ...d, [activeWorker]: nextWorkerData }));
      setDrafts((d) => ({ ...d, [activeWorker]: [] }));
      setActualInput("");
      setDateInput(todayStr());
      setSaveMsg("已保存今天的记录");
    } catch {
      setSaveMsg("保存失败，检查网络或Supabase配置，请重试一次");
    } finally {
      setSaving(false);
    }
  }

  const recentHistory = [...cur.history].slice(-14).reverse();
  const cumulativeLoss = cur.history.reduce(
    (s, r) => s + (r.loss || 0),
    0
  );

  if (!ready) {
    return (
      <div className="min-h-[300px] flex items-center justify-center text-stone-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        正在加载记录…
      </div>
    );
  }

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

      <p className="text-xs text-stone-500 mb-4">
        数据存在Supabase数据库里，团队里打开这个网址的人看到的是同一份记录。
      </p>

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
          还没有 {activeWorker} 的期初实重，先在下面填入今天过秤的重量作为起点，之后就能自动算损耗了。
        </div>
      )}

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5 mb-6">
        <h2 className="text-sm font-medium text-stone-300 mb-3">
          今日流水（{activeWorker}）
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
            {DESTINATIONS.map((d) => (
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
            今天还没有记录任何加减
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

        <div className="grid md:grid-cols-2 gap-4 items-end">
          <div>
            <label className="block text-xs text-stone-500 mb-1">日期</label>
            <input
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">
              实重（今天过秤读数，克）
            </label>
            <input
              type="number"
              step="0.01"
              placeholder="从秤上读到的数字"
              value={actualInput}
              onChange={(e) => setActualInput(e.target.value)}
              className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-lg font-mono tabular-nums text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
            />
          </div>
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
          保存今天
        </button>
        {saveMsg && (
          <p className="text-xs text-stone-400 mt-2">{saveMsg}</p>
        )}
      </div>

      <div className="bg-stone-900 border border-stone-800 rounded-xl p-4 md:p-5">
        <h2 className="text-sm font-medium text-stone-300 mb-3 flex items-center gap-2">
          <History className="w-4 h-4" />
          历史记录（最近 {recentHistory.length} 天）
        </h2>
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
                {recentHistory.map((r, i) => {
                  const over =
                    r.loss !== null && Math.abs(r.loss) > LOSS_THRESHOLD;
                  return (
                    <tr key={i}>
                      <td className="py-2 text-stone-400">{r.date}</td>
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
    </div>
  );
}
