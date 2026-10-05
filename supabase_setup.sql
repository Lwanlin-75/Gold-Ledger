-- DEPRECATED: this old public read/write setup is not compatible with production.
-- See TRANSFER_MAINTENANCE.md, LEDGER_SAFETY.md and supabase/migrations.
-- Never recreate or overwrite the production database from this file.
do $$begin raise exception 'deprecated_setup_do_not_run_use_reviewed_migrations';end $$;
