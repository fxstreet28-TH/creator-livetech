-- =====================================================================
-- AURUM Live — signup auth foundation
-- Project: hknvooaqgpufrbdxtzxf (Aurumtech, ap-southeast-2)
-- Apply via: Supabase Dashboard → SQL Editor (this project is intentionally
-- not connected to GitHub / MCP). Safe to run more than once (idempotent).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Base identity tables (fresh project — created from scratch)
-- ---------------------------------------------------------------------

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  email text unique,
  phone text unique,
  phone_verified_at timestamptz,
  email_verified_at timestamptz,
  role text default 'creator',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_user_id_idx on public.customers(user_id);
create index if not exists customers_email_idx on public.customers(email);
create index if not exists customers_phone_idx on public.customers(phone);

create table if not exists public.creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  customer_id uuid unique references public.customers(id) on delete cascade,
  handle text unique,
  display_name text,
  category text,
  bio text,
  kyc_status text default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists creators_user_id_idx on public.creators(user_id);
create index if not exists creators_handle_idx on public.creators(handle);

-- ---------------------------------------------------------------------
-- Signup sessions: pending signup state until both codes are verified
-- ---------------------------------------------------------------------
create table if not exists public.signup_sessions (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  email text not null,
  password_encrypted text not null,  -- AES-256-GCM encrypted with SESSION_ENCRYPTION_KEY
  phone_verified_at timestamptz,
  email_verified_at timestamptz,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists signup_sessions_phone_idx on public.signup_sessions(phone);
create index if not exists signup_sessions_email_idx on public.signup_sessions(email);
create index if not exists signup_sessions_expires_at_idx on public.signup_sessions(expires_at);

-- ---------------------------------------------------------------------
-- Phone OTPs
-- ---------------------------------------------------------------------
create table if not exists public.phone_otps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.signup_sessions(id) on delete cascade,
  phone text not null,
  code_hash text not null,        -- HMAC-SHA256 of the code with OTP_HMAC_SECRET
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  attempts int not null default 0,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists phone_otps_session_idx on public.phone_otps(session_id);
create index if not exists phone_otps_phone_created_idx on public.phone_otps(phone, created_at desc);

-- ---------------------------------------------------------------------
-- Email codes
-- ---------------------------------------------------------------------
create table if not exists public.email_codes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.signup_sessions(id) on delete cascade,
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  attempts int not null default 0,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_codes_session_idx on public.email_codes(session_id);
create index if not exists email_codes_email_created_idx on public.email_codes(email, created_at desc);

-- ---------------------------------------------------------------------
-- Rate limit ledger (used by both phone and email)
-- ---------------------------------------------------------------------
create table if not exists public.auth_rate_limits (
  id uuid primary key default gen_random_uuid(),
  key text not null,              -- e.g. "phone:+66812345678", "email:foo@bar.com", "ip:1.2.3.4"
  action text not null,           -- "send_sms", "send_email", "verify", "check"
  created_at timestamptz not null default now()
);
create index if not exists auth_rate_limits_lookup_idx on public.auth_rate_limits(key, action, created_at desc);

-- ---------------------------------------------------------------------
-- RLS: block all client access. These tables are service-role only.
-- (No policies = no access via anon/authenticated. Only service role bypasses RLS.)
-- ---------------------------------------------------------------------
alter table public.signup_sessions enable row level security;
alter table public.phone_otps enable row level security;
alter table public.email_codes enable row level security;
alter table public.auth_rate_limits enable row level security;

-- customers / creators also get RLS enabled; add read/write policies in a
-- later task once the dashboard/onboarding features define their access needs.
alter table public.customers enable row level security;
alter table public.creators enable row level security;
