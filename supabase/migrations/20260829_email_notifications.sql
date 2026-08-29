-- ---------------------------------------------------------------------
-- Transactional email notifications.
--
-- Three wallet moments get an email: a star purchase that succeeded, a
-- buyback paid out, and a buyback rejected (stars refunded). Everything
-- else the wallet does stays silent.
--
-- Shape: an AFTER trigger on the table whose state changed queues a
-- pg_net POST to the send-transactional-email Edge Function, which reads
-- the row back on the service key, renders the template and hands it to
-- Resend. The trigger carries no email content and no secrets of its own
-- — only the event name and the row id.
--
-- Why pg_net and not a call inside the RPCs: admin_transition_buyback_status
-- and admin_refund_buyback are money functions and stay pure. An email
-- provider being down must never roll back a payout. pg_net queues the
-- request in this transaction and dispatches it after commit, so a failed
-- send costs an email_log row and nothing else.
--
-- This is the first pg_net dependency in the schema. The expiration cron
-- (20260826_phase1_star_expiration_cycle.sql) deliberately avoided it by
-- calling the RPC from pg_cron directly; that reasoning does not carry
-- here, because rendering an email needs auth.users and a template engine
-- that Postgres does not have.
--
-- The two endpoint secrets live in Vault rather than in this file:
--   edge_function_email_url    the function's https URL
--   edge_function_service_key  the project service role key
-- Both are created out of band (see the PR description). When either is
-- missing the trigger warns and returns — a wallet write is never blocked
-- by an unconfigured mailer.
-- ---------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_net;


-- ---------------------------------------------------------------------
-- email_log — one row per send attempt, written by the Edge Function.
--
-- Kept as an audit trail rather than a queue: nothing reads it to decide
-- what to send next. It exists so "did the customer get told?" has an
-- answer that does not involve logging into Resend, and so a failed send
-- leaves the provider's rejection where it can be read.
--
-- reference_id is not unique. A retry after a failure should land as a
-- second row with its own error, not overwrite the first one's evidence.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_log (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type     TEXT NOT NULL
                     CHECK (event_type IN ('star_purchase', 'buyback_paid', 'buyback_rejected')),
    user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    to_email       TEXT NOT NULL,
    subject        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
    resend_id      TEXT,
    error          TEXT,
    reference_id   UUID,
    reference_type TEXT,
    payload        JSONB,
    attempts       INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS email_log_user_idx
    ON public.email_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_log_status_idx
    ON public.email_log (status, created_at DESC);
CREATE INDEX IF NOT EXISTS email_log_reference_idx
    ON public.email_log (reference_type, reference_id);

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

-- Own rows only. to_email is the address the user already gave us and
-- subject is a line they received, so there is nothing here they cannot
-- see in their own inbox.
DROP POLICY IF EXISTS email_log_read_own ON public.email_log;
CREATE POLICY email_log_read_own ON public.email_log
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Writes belong to the Edge Function on the service key, which bypasses
-- RLS. Revoked outright so a policy mistake cannot open a write path.
GRANT SELECT ON public.email_log TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.email_log FROM anon, authenticated;

COMMENT ON TABLE public.email_log IS
    'Audit trail of transactional emails dispatched via Resend. One row per send attempt.';


-- ---------------------------------------------------------------------
-- notify_email_edge_function — the one place that talks to pg_net.
--
-- Both triggers below funnel through it so the Vault lookup, the missing
-- secret handling and the request shape exist once.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_email_edge_function(
    p_event_type     TEXT,
    p_user_id        UUID,
    p_reference_id   UUID,
    p_reference_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_edge_url    TEXT;
    v_service_key TEXT;
BEGIN
    SELECT decrypted_secret INTO v_edge_url
      FROM vault.decrypted_secrets WHERE name = 'edge_function_email_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets WHERE name = 'edge_function_service_key';

    IF v_edge_url IS NULL OR v_service_key IS NULL THEN
        RAISE WARNING 'email notify: vault secrets missing, skipping % for %',
            p_event_type, p_reference_id;
        RETURN;
    END IF;

    -- Queued now, dispatched by the pg_net worker after this transaction
    -- commits. The Edge Function reads the row back, so it never sees
    -- uncommitted state.
    PERFORM net.http_post(
        url     := v_edge_url,
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_key
        ),
        body    := jsonb_build_object(
            'event_type',     p_event_type,
            'user_id',        p_user_id,
            'reference_id',   p_reference_id,
            'reference_type', p_reference_type
        )
    );
END;
$$;

COMMENT ON FUNCTION public.notify_email_edge_function(TEXT, UUID, UUID, TEXT) IS
    'Queues a pg_net POST to send-transactional-email. No-ops with a warning when the Vault secrets are absent.';


-- ---------------------------------------------------------------------
-- Buyback: paid and rejected.
--
-- Only the two terminal states customers are waiting on. 'approved' is an
-- internal step — the money has not moved yet and there is nothing to
-- tell anyone — and 'cancelled' is the user's own action.
--
-- admin_refund_buyback inserts the refund batch into star_purchases
-- before it updates this row, so by the time the POST is dispatched the
-- refund's expires_at is committed and readable.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_email_on_buyback_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    -- An UPDATE that rewrites the row without moving the status (a notes
    -- edit) must not re-send.
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('paid', 'rejected') THEN
        RETURN NEW;
    END IF;

    PERFORM public.notify_email_edge_function(
        CASE WHEN NEW.status = 'paid' THEN 'buyback_paid' ELSE 'buyback_rejected' END,
        NEW.user_id,
        NEW.id,
        'buyback_request'
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS buyback_status_email_trigger ON public.buyback_requests;
CREATE TRIGGER buyback_status_email_trigger
    AFTER UPDATE OF status ON public.buyback_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_email_on_buyback_status();

COMMENT ON FUNCTION public.trigger_email_on_buyback_status() IS
    'Emails the customer when a buyback reaches paid or rejected.';


-- ---------------------------------------------------------------------
-- Star purchase.
--
-- credit_stars_purchase inserts straight to 'succeeded', so INSERT is the
-- path that fires in practice; UPDATE OF payment_status is here for a
-- provider flow that ever lands pending first.
--
-- manual_admin batches are excluded. Those are either the refund leg of a
-- rejected buyback — the customer gets the buyback_rejected email, and a
-- second "you bought stars" for the same event would be wrong — or a comp
-- credit, which is an internal action nobody promised a receipt for.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_email_on_star_purchase()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    IF NEW.payment_status <> 'succeeded' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.payment_status = 'succeeded' THEN
        RETURN NEW;
    END IF;

    IF NEW.payment_method = 'manual_admin' THEN
        RETURN NEW;
    END IF;

    PERFORM public.notify_email_edge_function(
        'star_purchase',
        NEW.user_id,
        NEW.id,
        'star_purchase'
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS star_purchase_email_trigger ON public.star_purchases;
CREATE TRIGGER star_purchase_email_trigger
    AFTER INSERT OR UPDATE OF payment_status ON public.star_purchases
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_email_on_star_purchase();

COMMENT ON FUNCTION public.trigger_email_on_star_purchase() IS
    'Emails the buyer when a star purchase succeeds. Skips manual_admin batches (buyback refunds and comps).';


-- ---------------------------------------------------------------------
-- Rollback
--
-- To stop the emails without losing the definitions:
--   ALTER TABLE public.buyback_requests DISABLE TRIGGER buyback_status_email_trigger;
--   ALTER TABLE public.star_purchases   DISABLE TRIGGER star_purchase_email_trigger;
--
-- To remove them entirely (email_log is kept for the audit history):
--   DROP TRIGGER IF EXISTS buyback_status_email_trigger ON public.buyback_requests;
--   DROP TRIGGER IF EXISTS star_purchase_email_trigger  ON public.star_purchases;
--   DROP FUNCTION IF EXISTS public.trigger_email_on_buyback_status();
--   DROP FUNCTION IF EXISTS public.trigger_email_on_star_purchase();
--   DROP FUNCTION IF EXISTS public.notify_email_edge_function(TEXT, UUID, UUID, TEXT);
-- ---------------------------------------------------------------------
