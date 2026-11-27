-- The framework is LoopZero now, and it names its job queue and its cron lock `loopzero_*`. It creates them when
-- they are missing, so without this the queued jobs and the fired ticks would stay behind in the old tables.
-- A database the old framework never touched has nothing to rename, and one where the new framework already
-- started keeps what it created.
DO $$
DECLARE
  moved record;
BEGIN
  FOR moved IN
    SELECT * FROM (VALUES
      ('theokit_jobs', 'loopzero_jobs'),
      ('theokit_cron_runs', 'loopzero_cron_runs')
    ) AS t(old_name, new_name)
  LOOP
    IF to_regclass('public.' || moved.old_name) IS NOT NULL AND to_regclass('public.' || moved.new_name) IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', moved.old_name, moved.new_name);
    END IF;
  END LOOP;
  FOR moved IN
    SELECT * FROM (VALUES
      ('theokit_jobs_pkey', 'loopzero_jobs_pkey'),
      ('theokit_jobs_available_at_idx', 'loopzero_jobs_available_at_idx'),
      ('theokit_jobs_idempotency_key_idx', 'loopzero_jobs_idempotency_key_idx'),
      ('theokit_cron_runs_pkey', 'loopzero_cron_runs_pkey')
    ) AS t(old_name, new_name)
  LOOP
    IF to_regclass('public.' || moved.old_name) IS NOT NULL AND to_regclass('public.' || moved.new_name) IS NULL THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', moved.old_name, moved.new_name);
    END IF;
  END LOOP;
END $$;
