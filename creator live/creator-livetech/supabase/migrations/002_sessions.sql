create extension if not exists pgcrypto;

create table if not exists public.sessions (
  session_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_accounts (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on public.sessions (user_id);
create index if not exists sessions_expires_at_idx on public.sessions (expires_at);

alter table public.sessions enable row level security;

revoke all on public.sessions from anon, authenticated;
