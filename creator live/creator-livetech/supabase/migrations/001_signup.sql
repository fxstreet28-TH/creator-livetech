create extension if not exists pgcrypto;

create table if not exists public.signup_challenges (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 2 and 100),
  email text not null,
  phone text not null,
  password_hash text not null,
  email_code_hash text not null default '',
  movider_request_id text not null default '',
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  email_attempts integer not null default 0 check (email_attempts between 0 and 5),
  phone_attempts integer not null default 0 check (phone_attempts between 0 and 5),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists signup_active_email_idx
  on public.signup_challenges (email) where completed_at is null;
create unique index if not exists signup_active_phone_idx
  on public.signup_challenges (phone) where completed_at is null;

create table if not exists public.user_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  phone text not null unique,
  password_hash text not null,
  email_verified_at timestamptz not null,
  phone_verified_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.signup_challenges enable row level security;
alter table public.user_accounts enable row level security;

revoke all on public.signup_challenges from anon, authenticated;
revoke all on public.user_accounts from anon, authenticated;

create or replace function public.complete_signup(challenge_uuid uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.signup_challenges%rowtype;
  new_id uuid;
begin
  select * into c from public.signup_challenges
  where id = challenge_uuid for update;
  if not found or c.completed_at is not null or c.expires_at < now() then
    raise exception 'challenge invalid';
  end if;
  if c.email_verified_at is null or c.phone_verified_at is null then
    raise exception 'challenge not verified';
  end if;
  insert into public.user_accounts
    (full_name, email, phone, password_hash, email_verified_at, phone_verified_at)
  values
    (c.full_name, c.email, c.phone, c.password_hash, c.email_verified_at, c.phone_verified_at)
  returning id into new_id;
  update public.signup_challenges set completed_at = now() where id = challenge_uuid;
  return new_id;
end;
$$;

revoke all on function public.complete_signup(uuid) from public, anon, authenticated;
grant execute on function public.complete_signup(uuid) to service_role;
