-- =====================================================================
-- AURUM Live — Fanvue Phase 1 foundation schema
-- Project: hknvooaqgpufrbdxtzxf (Aurumtech, ap-southeast-2)
--
-- 18 new tables + their indexes, transcribed from
-- fanvue-phase1-requirements.md § 6 "New Tables (Phase 1)".
--
-- RLS is deliberately NOT enabled here — that is the next migration
-- (phase1_enable_rls / phase1_rls_*). Until then these tables are
-- reachable only by the service role, because the anon and authenticated
-- roles have no grants on them by default.
--
-- Applied via Supabase MCP apply_migration as `phase1_foundation_tables`.
-- Table order is FK-dependency order; do not reorder.
-- =====================================================================

-- ---------------------------------------------------------------------
-- creator_profiles (extends creators)
-- ---------------------------------------------------------------------
CREATE TABLE creator_profiles (
    creator_id UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
    handle TEXT UNIQUE NOT NULL,           -- @username (URL slug)
    display_name TEXT NOT NULL,
    bio TEXT,
    cover_url TEXT,                         -- R2 signed URL base
    avatar_url TEXT,
    category TEXT NOT NULL,                 -- 'trading' | 'spiritual' | 'coaching' | ...
    languages TEXT[] DEFAULT ARRAY['th'],
    is_public BOOLEAN DEFAULT true,         -- discoverable in /discover
    total_subscribers INTEGER DEFAULT 0,
    total_followers INTEGER DEFAULT 0,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_creator_profiles_handle ON creator_profiles(handle);
CREATE INDEX idx_creator_profiles_category ON creator_profiles(category);

-- ---------------------------------------------------------------------
-- subscription_plans (creator's pricing options)
-- ---------------------------------------------------------------------
CREATE TABLE subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                     -- e.g. 'Basic', 'Premium', 'VIP'
    description TEXT,
    price_thb NUMERIC(10,2) NOT NULL,       -- 50.00 - 2000.00
    price_stars INTEGER GENERATED ALWAYS AS ((price_thb / 10)::integer) STORED,
    benefits TEXT[],                        -- array of benefit strings
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (price_thb >= 50 AND price_thb <= 2000)
);

CREATE INDEX idx_subscription_plans_creator ON subscription_plans(creator_id, is_active);

-- ---------------------------------------------------------------------
-- subscriptions (subscriber -> creator)
-- ---------------------------------------------------------------------
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    price_stars INTEGER NOT NULL,           -- locked at time of subscription
    price_thb NUMERIC(10,2) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,        -- +30 days from starts_at
    auto_renew BOOLEAN DEFAULT true,
    status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'cancelled' | 'expired' | 'grace_period'
    cancelled_at TIMESTAMPTZ,
    grace_period_starts_at TIMESTAMPTZ,     -- when insufficient stars for renewal
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(subscriber_id, creator_id, starts_at)
);

CREATE INDEX idx_subscriptions_subscriber ON subscriptions(subscriber_id, status);
CREATE INDEX idx_subscriptions_creator ON subscriptions(creator_id, status);
CREATE INDEX idx_subscriptions_expires ON subscriptions(expires_at) WHERE status = 'active' AND auto_renew = true;

-- ---------------------------------------------------------------------
-- ppv_posts (creator's paid content)
-- ---------------------------------------------------------------------
CREATE TABLE ppv_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    title TEXT,
    description TEXT,
    price_thb NUMERIC(10,2) NOT NULL,
    price_stars INTEGER GENERATED ALWAYS AS ((price_thb / 10)::integer) STORED,
    media_type TEXT NOT NULL,               -- 'photo' | 'video' | 'audio' | 'photo_gallery'
    media_urls TEXT[] NOT NULL,             -- R2 keys (not signed URLs)
    preview_url TEXT,                       -- R2 key for blur/thumbnail
    duration_seconds INTEGER,               -- for video/audio
    total_unlocks INTEGER DEFAULT 0,
    is_published BOOLEAN DEFAULT true,
    published_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (price_thb >= 10 AND price_thb <= 2000)
);

CREATE INDEX idx_ppv_posts_creator ON ppv_posts(creator_id, published_at DESC);

-- ---------------------------------------------------------------------
-- ppv_unlocks (subscriber's purchased access)
-- ---------------------------------------------------------------------
CREATE TABLE ppv_unlocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES ppv_posts(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES creators(id),
    price_stars_paid INTEGER NOT NULL,      -- locked at time of purchase
    unlocked_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(subscriber_id, post_id)
);

CREATE INDEX idx_ppv_unlocks_subscriber ON ppv_unlocks(subscriber_id, unlocked_at DESC);
CREATE INDEX idx_ppv_unlocks_post ON ppv_unlocks(post_id);

-- ---------------------------------------------------------------------
-- feed_posts (public posts for subscribed feed)
-- ---------------------------------------------------------------------
CREATE TABLE feed_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    content TEXT,                           -- markdown
    media_urls TEXT[],                      -- optional attachments
    access_level TEXT NOT NULL,             -- 'public' | 'subscriber_only' | 'ppv'
    ppv_post_id UUID REFERENCES ppv_posts(id), -- if access_level = 'ppv'
    published_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_feed_posts_creator ON feed_posts(creator_id, published_at DESC);
CREATE INDEX idx_feed_posts_published ON feed_posts(published_at DESC) WHERE access_level = 'public';

-- ---------------------------------------------------------------------
-- conversations (DM threads)
-- ---------------------------------------------------------------------
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    subscriber_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    unread_count_creator INTEGER DEFAULT 0,
    unread_count_subscriber INTEGER DEFAULT 0,
    is_archived_creator BOOLEAN DEFAULT false,
    is_archived_subscriber BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(creator_id, subscriber_id)
);

CREATE INDEX idx_conversations_creator ON conversations(creator_id, last_message_at DESC);
CREATE INDEX idx_conversations_subscriber ON conversations(subscriber_id, last_message_at DESC);

-- ---------------------------------------------------------------------
-- messages (individual DM messages)
-- ---------------------------------------------------------------------
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES auth.users(id),
    sender_role TEXT NOT NULL,              -- 'creator' | 'subscriber'
    message_type TEXT NOT NULL,             -- 'text' | 'media' | 'ppv' | 'tip'
    content TEXT,                           -- text content or caption
    media_urls TEXT[],                      -- for media/ppv
    price_stars INTEGER,                    -- for PPV messages
    tip_stars INTEGER,                      -- for tips
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages(sender_id, created_at DESC);

-- ---------------------------------------------------------------------
-- message_purchases (PPV in DM)
-- ---------------------------------------------------------------------
CREATE TABLE message_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES auth.users(id),
    creator_id UUID NOT NULL REFERENCES creators(id),
    price_stars_paid INTEGER NOT NULL,
    unlocked_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_id, buyer_id)
);

CREATE INDEX idx_message_purchases_buyer ON message_purchases(buyer_id);

-- ---------------------------------------------------------------------
-- stars_wallet (user's Star balance)
-- ---------------------------------------------------------------------
CREATE TABLE stars_wallet (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    total_balance INTEGER NOT NULL DEFAULT 0,
    total_purchased INTEGER NOT NULL DEFAULT 0,  -- lifetime
    total_spent INTEGER NOT NULL DEFAULT 0,      -- lifetime
    total_expired INTEGER NOT NULL DEFAULT 0,    -- lifetime
    total_bought_back INTEGER NOT NULL DEFAULT 0, -- lifetime
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stars_wallet_balance ON stars_wallet(total_balance);

-- ---------------------------------------------------------------------
-- star_purchases (buy Stars via Stripe/OxaPay)
-- ---------------------------------------------------------------------
CREATE TABLE star_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stars_amount INTEGER NOT NULL,
    thb_amount NUMERIC(10,2) NOT NULL,
    payment_method TEXT NOT NULL,           -- 'stripe' | 'oxapay'
    payment_provider_id TEXT NOT NULL,      -- Stripe PaymentIntent ID or OxaPay Invoice ID
    payment_status TEXT NOT NULL,           -- 'pending' | 'succeeded' | 'failed' | 'refunded_via_chargeback'
    expires_at TIMESTAMPTZ NOT NULL,        -- purchase_date + 6 months
    remaining_stars INTEGER,                -- decreases as user spends (FIFO)
    metadata JSONB,                         -- provider webhook payload
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CHECK (stars_amount >= 100 AND stars_amount <= 10000)
);

CREATE INDEX idx_star_purchases_user ON star_purchases(user_id, created_at DESC);
CREATE INDEX idx_star_purchases_expires ON star_purchases(expires_at) WHERE remaining_stars > 0;
CREATE UNIQUE INDEX idx_star_purchases_provider ON star_purchases(payment_provider_id);

-- ---------------------------------------------------------------------
-- star_transactions (spending log — every deduction)
-- ---------------------------------------------------------------------
CREATE TABLE star_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    transaction_type TEXT NOT NULL,         -- 'subscribe' | 'ppv_unlock' | 'ppv_message' | 'tip' | 'buyback' | 'expiration'
    stars_delta INTEGER NOT NULL,           -- negative for spend, positive for credit (buyback = negative wallet, but stars removed)
    reference_id UUID,                      -- subscription_id, ppv_unlock_id, message_purchase_id, buyback_id, etc.
    reference_type TEXT,                    -- 'subscription' | 'ppv_unlock' | ...
    creator_id UUID REFERENCES creators(id),  -- who received (for spends)
    purchase_batch_ids UUID[],              -- which star_purchases were deducted (FIFO)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_star_transactions_user ON star_transactions(user_id, created_at DESC);
CREATE INDEX idx_star_transactions_creator ON star_transactions(creator_id, created_at DESC) WHERE creator_id IS NOT NULL;
CREATE INDEX idx_star_transactions_type ON star_transactions(transaction_type, created_at DESC);

-- ---------------------------------------------------------------------
-- star_buybacks (user-initiated cashout)
-- ---------------------------------------------------------------------
CREATE TABLE star_buybacks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stars_amount INTEGER NOT NULL,
    thb_amount NUMERIC(10,2) NOT NULL,      -- stars * 3
    payout_method TEXT NOT NULL,            -- 'bank_transfer' | 'crypto_usdt'
    payout_details JSONB,                   -- {bank_name, account_no, holder_name} or {wallet_address, network}
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'paid' | 'rejected'
    rejection_reason TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (stars_amount >= 100 AND stars_amount <= 10000)
);

CREATE INDEX idx_star_buybacks_user ON star_buybacks(user_id, created_at DESC);
CREATE INDEX idx_star_buybacks_pending ON star_buybacks(status, created_at) WHERE status IN ('pending', 'processing');

-- ---------------------------------------------------------------------
-- creator_tier_snapshots (monthly tier calculation)
-- ---------------------------------------------------------------------
CREATE TABLE creator_tier_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,                 -- 1-12
    total_stars_received INTEGER NOT NULL,
    tier INTEGER NOT NULL,                  -- 1-4
    platform_cut_pct NUMERIC(5,2) NOT NULL, -- 30.00, 25.00, 20.00, 15.00
    platform_cut_stars INTEGER NOT NULL,
    creator_net_stars INTEGER NOT NULL,
    creator_net_thb NUMERIC(12,2) NOT NULL,
    snapshot_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(creator_id, year, month)
);

CREATE INDEX idx_creator_tier_snapshots_creator ON creator_tier_snapshots(creator_id, year DESC, month DESC);

-- ---------------------------------------------------------------------
-- payouts (monthly creator payouts)
-- ---------------------------------------------------------------------
CREATE TABLE payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    tier_snapshot_id UUID NOT NULL REFERENCES creator_tier_snapshots(id),
    stars_amount INTEGER NOT NULL,
    thb_amount NUMERIC(12,2) NOT NULL,
    payout_method TEXT NOT NULL,            -- 'bank_transfer' | 'crypto_usdt'
    payout_details JSONB,
    status TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'processing' | 'paid' | 'failed' | 'held'
    scheduled_for DATE NOT NULL,            -- 1st-5th of following month
    processed_at TIMESTAMPTZ,
    provider_transaction_id TEXT,           -- Stripe payout ID or OxaPay tx hash
    failure_reason TEXT,
    hold_reason TEXT,                       -- e.g. 'kyc_pending', 'dispute_investigation'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(creator_id, tier_snapshot_id)
);

CREATE INDEX idx_payouts_creator ON payouts(creator_id, scheduled_for DESC);
CREATE INDEX idx_payouts_scheduled ON payouts(scheduled_for) WHERE status = 'scheduled';

-- ---------------------------------------------------------------------
-- kyc_records (creator identity verification)
-- ---------------------------------------------------------------------
CREATE TABLE kyc_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    nationality TEXT NOT NULL,
    address TEXT NOT NULL,
    id_document_type TEXT NOT NULL,         -- 'national_id' | 'passport'
    id_document_url TEXT NOT NULL,          -- R2 key (encrypted)
    selfie_url TEXT NOT NULL,               -- R2 key (encrypted)
    address_proof_url TEXT,                 -- R2 key (encrypted)
    bank_account JSONB,                     -- {bank_name, account_no, holder_name}
    provider TEXT,                          -- 'onfido' | 'sumsub' | 'manual'
    provider_reference_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending_review',
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    verified_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES auth.users(id),
    CHECK (date_of_birth <= NOW() - INTERVAL '18 years')  -- 18+ only
);

CREATE INDEX idx_kyc_records_creator ON kyc_records(creator_id);
CREATE INDEX idx_kyc_records_pending ON kyc_records(status, submitted_at) WHERE status = 'pending_review';

-- ---------------------------------------------------------------------
-- media_assets (R2 storage tracking)
-- ---------------------------------------------------------------------
CREATE TABLE media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id),
    owner_type TEXT NOT NULL,               -- 'creator' | 'subscriber'
    r2_key TEXT UNIQUE NOT NULL,            -- R2 storage key
    filename TEXT,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_seconds INTEGER,
    context TEXT NOT NULL,                  -- 'ppv_post' | 'dm_message' | 'kyc_document' | 'profile_avatar' | 'profile_cover'
    reference_id UUID,                      -- ppv_post_id or message_id or kyc_record_id
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_media_assets_owner ON media_assets(owner_id);
CREATE INDEX idx_media_assets_reference ON media_assets(reference_id);

-- ---------------------------------------------------------------------
-- follows (free follow, not subscription)
-- ---------------------------------------------------------------------
CREATE TABLE follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    followed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id, creator_id)
);

CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_creator ON follows(creator_id);
