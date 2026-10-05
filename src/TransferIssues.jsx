import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabaseClient.js';

// A small, permission-filtered notice area. Match and resolution remain administrator actions.
export default function TransferIssues({ worker, lang }) {
  const [issues, setIssues] = useState([]);
  const [waiting, setWaiting] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const t = (zh, en) => lang === 'en' ? en : zh;
  const typeLabels = {
    WEIGHT_MISMATCH: t('重量差异待调查','Weight difference to investigate'),
    SENT_NOT_RECEIVED: t('已转出，尚未找到接收记录','Sent; receipt not recorded'),
    POSSIBLE_WRONG_WEIGHT: t('疑似重量输入错误','Possible weight entry error'),
    POSSIBLE_WRONG_DIRECTION: t('疑似正负方向错误','Possible sign/direction error'),
    POSSIBLE_MISSING_ENTRY: t('疑似漏记录','Possible missing entry'),
    POSSIBLE_DUPLICATE_ENTRY: t('疑似重复记录','Possible duplicate entry'),
    OTHER: t('其他异常待调查','Other issue to investigate'),
  };
  const statusLabels = {
    OPEN: t('待处理','Open'),WAITING_STAFF:t('等待员工调查','Awaiting staff investigation'),
    STAFF_REPLIED:t('员工已留言，待复核','Staff replied; awaiting review'),
    READY_FOR_REVIEW:t('已检查，待管理员复核','Ready for administrator review'),
  };
  const refresh = useCallback(async () => {
    const { data, error: failure } = await supabase.rpc('transfer_get_worker_transfer_notices', { p_worker: worker });
    if (failure) { setError(lang === 'en' ? 'Issue notices could not be loaded. Retry.' : '异常公告加载失败，请重试。'); return; }
    setIssues(data?.issues || []); setWaiting(data?.waiting || []); setError('');
  }, [worker, lang]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data, error: failure } = await supabase.rpc('transfer_get_worker_transfer_notices', { p_worker: worker });
      if (!active) return;
      setIssues(failure ? [] : data?.issues || []);setWaiting(failure ? [] : data?.waiting || []);
      setError(failure ? (lang === 'en' ? 'Issue notices could not be loaded. Retry.' : '异常公告加载失败，请重试。') : '');
    };
    setIssues([]);setWaiting([]);setExpanded(false);load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { active = false;clearInterval(timer);window.removeEventListener('focus', onFocus); };
  }, [worker, lang]);
  async function submit(issue, checked) {
    const text = (comments[issue.id] || '').trim();
    if (!text || busy) return;
    setBusy(issue.id);setError('');
    try {
      const { error: failure } = await supabase.rpc(checked ? 'transfer_mark_issue_reviewed' : 'transfer_add_issue_comment',
        checked ? { p_issue_id: issue.id, p_comment: text } : { p_issue_id: issue.id, p_comment: text });
      if (failure) throw failure;
      setComments(previous => ({ ...previous, [issue.id]: '' }));
      await refresh();
    } catch {
      setError(t('留言未保存，请重试。', 'Comment was not saved. Retry.'));
    } finally { setBusy(null); }
  }
  if (!issues.length && !waiting.length && !error) return null;
  const red = issues.some(issue => issue.is_red);
  return (
    <section className={`mb-4 rounded-lg border p-3 text-xs ${red ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setExpanded(value => !value)} className="font-medium text-left">
          {t('转手异常 / 待处理', 'Transfer issues / follow-up')} · {worker} ({issues.length}) {waiting.length > 0 && `· ${t("等待接收", "Awaiting receipt")} ${waiting.length}`}
        </button>
        <button onClick={refresh} disabled={!!busy}>{t('刷新', 'Refresh')}</button>
      </div>
      {error && <p className="mt-2" role="alert">{error}</p>}
      {expanded && waiting.map(entry => <p key={entry.item_id} className="mt-2 text-amber-300">{entry.worker} → {entry.counterparty} · {entry.date} · {Math.abs(Number(entry.amount)).toFixed(2)}g · {entry.overdue ? t("已超过等待期限，待管理员检查", "Receive deadline exceeded; awaiting admin review") : t("等待对方补接收记录", "Awaiting receiving entry")}</p>)}
      {expanded && issues.map(issue => (
        <div key={issue.id} className="mt-3 border-t border-stone-700 pt-3">
          <p className="font-medium">{issue.assigned_workers.join(' ↔ ')} · {typeLabels[issue.issue_type] || issue.issue_type} · {statusLabels[issue.status] || issue.status}</p>
          <p className="mt-1">{[...new Set(issue.initial_items.map(item => item.date))].join(' / ')} · {t('转出', 'Sent')}: {Number(issue.total_out).toFixed(2)}g · {t('收到', 'Received')}: {Number(issue.total_in).toFixed(2)}g · {t('当时差异', 'Initial difference')}: {Math.abs(Number(issue.difference)).toFixed(2)}g</p>
          <p className="mt-1">{issue.reason}</p>
          {issue.current_items.length > 0 && <p className="mt-1 text-stone-400">{t('当前流水', 'Current entries')}: {issue.current_items.map(item => `${item.worker} ${item.date} ${Number(item.amount).toFixed(2)}g${item.available ? '' : t('（已移除）',' (removed)')}`).join(' · ')}</p>}
          <p className="mt-1">{t('请检查并留言；管理员复核后才解除红色。', 'Please investigate and comment. Red stays until administrator review.')}</p>
          <div className="mt-2 space-y-1 text-stone-300">
            {issue.events.filter(event => event.event_type === 'staff_comment').map(event => (
              <p key={event.event_id} className="whitespace-pre-wrap break-words">
                {(event.metadata.workers || []).join(' / ') || event.actor_role} · {new Date(event.timestamp).toLocaleString('en-GB', { timeZone:'Asia/Kuala_Lumpur' })}: {event.message}
              </p>
            ))}
          </div>
          <textarea aria-label={t('异常调查说明', 'Issue investigation comment')} maxLength={5000} rows={2}
            value={comments[issue.id] || ''} onChange={event => setComments(previous => ({ ...previous, [issue.id]: event.target.value }))}
            placeholder={t('检查后填写原因或补记录说明', 'Explain your investigation or correction')}
            className="mt-2 w-full rounded border border-stone-700 bg-stone-950 p-2 text-stone-100" />
          <div className="mt-2 flex gap-3">
            <button disabled={!!busy || !(comments[issue.id] || '').trim()} onClick={() => submit(issue, false)} className="disabled:opacity-40">{t('添加留言', 'Add comment')}</button>
            <button disabled={!!busy || !(comments[issue.id] || '').trim()} onClick={() => submit(issue, true)} className="disabled:opacity-40">{t('已检查，提交复核', 'Checked, submit for review')}</button>
          </div>
        </div>
      ))}
    </section>
  );
}
