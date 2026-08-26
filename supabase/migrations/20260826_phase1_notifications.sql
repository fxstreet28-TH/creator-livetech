-- =====================================================================
-- Phase E — in-app notifications (Step E.1).
-- Applied via Supabase MCP as `phase1_notifications`.
--
-- email_sent / email_sent_at exist for the § 8.10 expiry emails. Rows are
-- written by the cron, but nothing dispatches email yet — see the note in
-- cron-star-expirations/index.ts.
-- =====================================================================

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                     -- 'stars_expiring_30d' | 'stars_expiring_14d' | ...
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    reference_id UUID,                      -- e.g. star_purchase_id
    reference_type TEXT,                    -- e.g. 'star_purchase'
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMPTZ,
    email_sent BOOLEAN DEFAULT false,
    email_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id, created_at DESC)
    WHERE is_read = false;
CREATE INDEX idx_notifications_email_pending ON notifications(created_at)
    WHERE email_sent = false;

-- Added beyond the spec'd DDL: the cron's dedupe check is "has this
-- (user, type, reference_id) already been sent", and it runs once per
-- candidate batch on every daily run. Without this index that is a
-- sequential scan per batch. Being UNIQUE also makes idempotency a
-- database guarantee rather than only a check-then-insert race — the
-- cron relies on ON CONFLICT DO NOTHING against it.
CREATE UNIQUE INDEX idx_notifications_dedupe
    ON notifications(user_id, type, reference_id)
    WHERE reference_id IS NOT NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_select_own" ON notifications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "notifications_mark_read_own" ON notifications
    FOR UPDATE USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
