-- Deploy the previous frontend first. Emergency rollback only: Worker scope enforcement will revert.
-- Audit rows, business records and the new employee mappings are preserved.
begin;
set local lock_timeout='10s';
lock table public.gold_ledger in share row exclusive mode;
drop trigger ledger_mutation_audit on public.gold_ledger;
do $$declare r record;begin
  for r in select definition from transfer_maintenance.ledger_safety_function_backup loop execute r.definition;end loop;
end $$;
revoke all on function public.ledger_get_worker_scope(),public.ledger_get_audit(text,bigint,integer),
  public.shipment_create_with_flow(jsonb,text),public.shipment_delete_with_flow(text,text),
  public.ledger_undo_last_day(text,jsonb,text),public.ledger_archive_batch(jsonb) from public,anon,authenticated;
-- Restored routines retain the original project's runtime auth checks.
grant execute on function public.upsert_draft_item(text,text,jsonb),public.remove_draft_item(text,text,text),
  public.edit_history_record(text,text,text,jsonb,numeric),public.save_day(text,text,numeric),
  public.append_special_record(text,jsonb,text,integer),public.update_special_record(text,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
