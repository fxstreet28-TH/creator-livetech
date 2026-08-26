-- =====================================================================
-- Phase E — daily schedule (Step E.3).
-- Applied via Supabase MCP as `enable_pg_cron_and_schedule`.
--
-- DEVIATION from Step E.3, which schedules a pg_net POST to the
-- cron-star-expirations Edge Function authenticated with
-- current_setting('app.settings.service_role_key'). That setting does not
-- exist on this project, and creating it would mean storing the
-- service-role key in the database, where every superuser query and every
-- pg_dump would carry it.
--
-- Calling run_star_expiration_cycle() directly is strictly simpler than
-- either that or the doc's Vercel Cron fallback: no pg_net dependency, no
-- HTTP hop that can fail or time out, no secret at rest, and the whole
-- cycle runs in one transaction. The Edge Function still exists and calls
-- the very same function, so the manual curl test is unchanged and the
-- two paths cannot drift.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Daily at 02:00 UTC = 09:00 Asia/Bangkok (§ 8.10).
SELECT cron.unschedule('star-expirations-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'star-expirations-daily');

SELECT cron.schedule(
    'star-expirations-daily',
    '0 2 * * *',
    $$SELECT run_star_expiration_cycle();$$
);
