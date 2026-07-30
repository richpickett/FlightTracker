-- Personal Wings — accounts + saved routes schema
-- Run once in Supabase → SQL Editor.

-- USER DIRECTORY (name + email per user, for notifications)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  email text,
  default_reg text,           -- per-user default aircraft tail # for live tracking
  is_admin boolean not null default false,   -- admin rights for /admin.html and /users.html
  created_at timestamptz default now()
);
-- migrations for an existing profiles table (safe to re-run):
alter table public.profiles add column if not exists default_reg text;
alter table public.profiles add column if not exists is_admin boolean not null default false;
-- BOOTSTRAP: make yourself the first admin (run once, edit the email):
--   update public.profiles set is_admin = true where email = 'rich@personalwings.com';
alter table public.profiles enable row level security;
drop policy if exists "profiles_own_read" on public.profiles;
create policy "profiles_own_read" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profiles_own_upd" on public.profiles;
create policy "profiles_own_upd" on public.profiles for update using (auth.uid() = id);

-- auto-create a profile row on signup (captures name from signup metadata + email)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name',''), new.email)
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- SAVED ROUTES (per user)
create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  route text not null,
  aircraft jsonb,
  updated_at timestamptz default now()
);
alter table public.routes enable row level security;
drop policy if exists "routes_own_all" on public.routes;
create policy "routes_own_all" on public.routes for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- As the owner/admin you can read the full user directory from the Supabase
-- dashboard (Table editor → profiles) or via the service_role key server-side.
