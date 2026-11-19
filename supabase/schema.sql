-- Run this in Supabase SQL Editor.
create table if not exists public.mafia_rooms (
  code text primary key check (length(code)=6),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.mafia_rooms enable row level security;
-- No client policies: only the Edge Function service role can read/write room state.
revoke all on public.mafia_rooms from anon, authenticated;
