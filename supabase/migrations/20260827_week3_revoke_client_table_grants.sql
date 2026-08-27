-- =====================================================================
-- AURUM Live — Week 3 follow-up: tighten client grants on the new tables
--
-- Supabase grants anon and authenticated every table privilege on new
-- tables in public by default, and the Week 3 migration revoked only
-- INSERT, UPDATE and DELETE from them. That left TRUNCATE, TRIGGER and
-- REFERENCES — and TRUNCATE is a write that RLS does not police: a policy
-- restricts which rows a statement sees, while TRUNCATE removes all of
-- them without consulting one.
--
-- Nothing can reach it today. PostgREST exposes no TRUNCATE, so a client
-- holding the anon or authenticated key has no way to issue the statement.
-- But "unreachable through the API we happen to put in front of it" is a
-- weaker guarantee than "not granted", and buyback_requests holds payout
-- obligations while star_payment_intents holds money in flight.
--
-- So the grants are reduced to exactly what each table's RLS policy needs:
-- SELECT where there is a read policy, nothing at all where there is not.
-- stripe_events already had everything revoked in the first migration.
--
-- Applied via Supabase MCP as `week3_revoke_client_table_grants`.
--
-- The Phase 1 tables carry the same default grants and are deliberately
-- left alone here: changing them is a separate audit with its own
-- blast radius, not a footnote to the Stripe PR.
-- =====================================================================

REVOKE ALL ON public.star_pricing_config   FROM anon, authenticated;
REVOKE ALL ON public.buyback_requests      FROM anon, authenticated;
REVOKE ALL ON public.star_payment_intents  FROM anon, authenticated;

-- SELECT only, and only for signed-in users: each of these three has a
-- policy that narrows the rows further (the live price; your own rows).
GRANT SELECT ON public.star_pricing_config   TO authenticated;
GRANT SELECT ON public.buyback_requests      TO authenticated;
GRANT SELECT ON public.star_payment_intents  TO authenticated;
