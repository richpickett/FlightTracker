-- ============================================================================
-- Personal Wings — cost tracking addendum
-- Run in the Supabase SQL editor AFTER cost_schema.sql. Idempotent.
--   * adds the free WX meter (aviationweather.gov calls — $0, tracked for volume)
--   * adds a rolling-30-day cost view for the dashboard
-- ============================================================================

insert into cost_service (code, description, billing_unit) values
  ('wx_call', 'aviationweather.gov call (METAR/TAF/SIGMET) — free', 'call')
on conflict (code) do nothing;

insert into service_rate (service_id, unit_price_usd, effective_from)
select c.service_id, 0, timestamptz '2026-01-01'
from cost_service c
where c.code = 'wx_call'
  and not exists (select 1 from service_rate sr where sr.service_id = c.service_id);

create or replace view v_cost_rolling30
  with (security_invoker = true) as
select count(*)                                              as briefings,
       coalesce(sum(total_usd),0)::numeric(14,4)             as total_usd,
       (coalesce(sum(total_usd),0)/nullif(count(*),0))::numeric(14,6) as avg_usd_per_briefing
from v_briefing_cost
where occurred_at >= now() - interval '30 days';

grant select on v_cost_rolling30 to authenticated;
