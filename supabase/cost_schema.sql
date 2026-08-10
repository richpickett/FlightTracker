-- ============================================================================
-- Personal Wings — briefing cost tracking (3rd normal form)
-- Run once in the Supabase SQL editor. Idempotent: safe to re-run.
--
-- Model:
--   cost_service   reference : one row per billable meter (a "unit you pay for")
--   service_rate   reference : price history per service (never overwrite a price)
--   briefing       fact      : one row per briefing event
--   briefing_usage fact      : one row per service consumed by a briefing (quantity only)
-- Cost is NEVER stored — it is computed in views as quantity x the rate in effect
-- at the briefing time. That is what keeps this 3NF: no derived $ in the tables,
-- prices factored out with history, every meter atomic.
-- ============================================================================

-- ---------- reference tables -------------------------------------------------
create table if not exists cost_service (
  service_id   serial primary key,
  code         text not null unique,
  description  text not null,
  billing_unit text not null check (billing_unit in ('call','token'))
);

create table if not exists service_rate (
  rate_id        serial primary key,
  service_id     int not null references cost_service(service_id),
  unit_price_usd numeric(14,10) not null check (unit_price_usd >= 0),
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  check (effective_to is null or effective_to > effective_from)
);
create index if not exists ix_service_rate_lookup on service_rate(service_id, effective_from desc);

-- ---------- fact tables ------------------------------------------------------
create table if not exists briefing (
  briefing_id    uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete set null,
  client_id      text,                                  -- random per-device id for anonymous usage
  occurred_at    timestamptz not null default now(),
  route_text     text,
  waypoint_count int,
  aircraft_reg   text
);
create index if not exists ix_briefing_occurred on briefing(occurred_at);
create index if not exists ix_briefing_user     on briefing(user_id);

create table if not exists briefing_usage (
  usage_id    bigserial primary key,
  briefing_id uuid not null references briefing(briefing_id) on delete cascade,
  service_id  int  not null references cost_service(service_id),
  quantity    numeric(14,4) not null check (quantity >= 0),
  unique (briefing_id, service_id)
);
create index if not exists ix_usage_briefing on briefing_usage(briefing_id);

-- ---------- admins (who may read the aggregate reports) ----------------------
create table if not exists admin_user (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------- seed the meters --------------------------------------------------
insert into cost_service (code, description, billing_unit) values
  ('places_call',       'Google Places Nearby (food) API call',       'call'),
  ('notam_call',        'SkyLink NOTAM API call',                     'call'),
  ('llm_in_haiku45',    'Anthropic claude-haiku-4-5 input tokens',    'token'),
  ('llm_out_haiku45',   'Anthropic claude-haiku-4-5 output tokens',   'token'),
  ('llm_in_gpt4omini',  'OpenAI gpt-4o-mini input tokens',            'token'),
  ('llm_out_gpt4omini', 'OpenAI gpt-4o-mini output tokens',           'token')
on conflict (code) do nothing;

-- ---------- seed current rates (USD per unit) --------------------------------
-- token rates = per-MTok / 1e6 : Places $0.035/call, SkyLink $0.0038/call,
-- Haiku 4.5 $1.00/$5.00 per MTok, gpt-4o-mini $0.15/$0.60 per MTok.
insert into service_rate (service_id, unit_price_usd, effective_from)
select c.service_id, r.price, timestamptz '2026-01-01'
from cost_service c
join (values
  ('places_call',       0.0350000000),
  ('notam_call',        0.0038000000),
  ('llm_in_haiku45',    0.0000010000),
  ('llm_out_haiku45',   0.0000050000),
  ('llm_in_gpt4omini',  0.0000001500),
  ('llm_out_gpt4omini', 0.0000006000)
) as r(code, price) on r.code = c.code
where not exists (select 1 from service_rate sr where sr.service_id = c.service_id);

-- ============================================================================
-- Row-level security
--   * anyone (anon or signed-in) may INSERT a briefing + usage  -> logging works for all users
--   * only the owner (or an admin) may SELECT briefing rows      -> no cross-user leakage
--   * reference tables are world-readable
-- ============================================================================
alter table briefing       enable row level security;
alter table briefing_usage enable row level security;
alter table cost_service   enable row level security;
alter table service_rate   enable row level security;
alter table admin_user     enable row level security;

grant insert on briefing, briefing_usage to anon, authenticated;
grant usage,  select on sequence briefing_usage_usage_id_seq to anon, authenticated;
grant select on briefing, briefing_usage, cost_service, service_rate to authenticated;
grant select on cost_service, service_rate to anon;

drop policy if exists briefing_insert       on briefing;
drop policy if exists briefing_select_scoped on briefing;
drop policy if exists usage_insert          on briefing_usage;
drop policy if exists usage_select_scoped    on briefing_usage;
drop policy if exists service_read           on cost_service;
drop policy if exists rate_read              on service_rate;
drop policy if exists admin_self             on admin_user;

create policy briefing_insert on briefing
  for insert to anon, authenticated with check (true);

create policy briefing_select_scoped on briefing
  for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from admin_user a where a.user_id = auth.uid()));

create policy usage_insert on briefing_usage
  for insert to anon, authenticated with check (true);

create policy usage_select_scoped on briefing_usage
  for select to authenticated
  using (exists (select 1 from briefing b
                 where b.briefing_id = briefing_usage.briefing_id
                   and (b.user_id = auth.uid()
                        or exists (select 1 from admin_user a where a.user_id = auth.uid()))));

create policy service_read on cost_service for select to anon, authenticated using (true);
create policy rate_read    on service_rate for select to anon, authenticated using (true);
create policy admin_self   on admin_user   for select to authenticated using (user_id = auth.uid());

-- ============================================================================
-- Reporting views (security_invoker => caller's RLS applies; an admin sees all)
-- ============================================================================
create or replace view v_briefing_usage_cost
  with (security_invoker = true) as
select bu.usage_id, b.briefing_id, b.user_id, b.client_id, b.occurred_at,
       cs.code as service_code, cs.billing_unit, bu.quantity,
       sr.unit_price_usd,
       (bu.quantity * coalesce(sr.unit_price_usd,0))::numeric(14,6) as amount_usd
from briefing_usage bu
join briefing     b  on b.briefing_id = bu.briefing_id
join cost_service cs on cs.service_id = bu.service_id
left join lateral (
  select unit_price_usd from service_rate sr
  where sr.service_id = bu.service_id
    and sr.effective_from <= b.occurred_at
    and (sr.effective_to is null or sr.effective_to > b.occurred_at)
  order by sr.effective_from desc limit 1
) sr on true;

create or replace view v_briefing_cost
  with (security_invoker = true) as
select b.briefing_id, b.user_id, b.client_id, b.occurred_at, b.route_text, b.aircraft_reg,
       coalesce(sum(uc.amount_usd),0)::numeric(14,6) as total_usd
from briefing b
left join v_briefing_usage_cost uc on uc.briefing_id = b.briefing_id
group by b.briefing_id, b.user_id, b.client_id, b.occurred_at, b.route_text, b.aircraft_reg;

create or replace view v_cost_by_month
  with (security_invoker = true) as
select date_trunc('month', occurred_at) as month,
       count(*)                                        as briefings,
       sum(total_usd)::numeric(14,4)                   as total_usd,
       (sum(total_usd)/nullif(count(*),0))::numeric(14,6) as avg_usd_per_briefing
from v_briefing_cost group by 1 order by 1;

create or replace view v_cost_by_service
  with (security_invoker = true) as
select date_trunc('month', occurred_at) as month, service_code,
       sum(quantity)::numeric(18,2)  as quantity,
       sum(amount_usd)::numeric(14,4) as amount_usd
from v_briefing_usage_cost group by 1,2 order by 1,2;

create or replace view v_cost_by_user
  with (security_invoker = true) as
select coalesce(user_id::text, 'anon:'||coalesce(client_id,'?')) as who,
       (user_id is not null)                              as signed_in,
       count(*)                                           as briefings,
       sum(total_usd)::numeric(14,4)                      as total_usd,
       (sum(total_usd)/nullif(count(*),0))::numeric(14,6) as avg_usd_per_briefing,
       min(occurred_at) as first_seen, max(occurred_at) as last_seen
from v_briefing_cost group by 1,2 order by total_usd desc;

grant select on v_briefing_usage_cost, v_briefing_cost, v_cost_by_month,
               v_cost_by_service, v_cost_by_user to authenticated;

-- ============================================================================
-- Make yourself an admin so the dashboard can read the aggregates:
--   (run this once; safe to re-run)
insert into admin_user (user_id)
select id from auth.users where email = 'rich@personalwings.com'
on conflict do nothing;
-- ============================================================================
