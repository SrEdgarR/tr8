-- Creating a secondary calendar is internally uncertain before HTTP returns.
-- A live provision lease is ordinary preparation in the user-facing status;
-- do not present a recovery error during that brief, expected interval.
-- The stored state and duplicate-creation guards remain unchanged.
create or replace function tr8_private.v5_status(p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c record; v_config boolean; v_pending integer; v_failed integer;
begin
  select configured into v_config from tr8_private.google_config where singleton;
  -- One statement snapshot for connection and lease. Reading them separately
  -- could combine an old unknown state with an already-finished lease.
  select g.*, (g.state='provisioning_unknown' and exists(
    select 1 from tr8_private.google_jobs j where j.connection_id=g.id and j.generation=g.generation
      and j.kind='provision' and j.state='leased' and j.lease_expires_at>clock_timestamp()
  )) as active_provision into c from tr8_private.google_connections g where g.user_id=p_actor;
  select count(*) filter(where state in ('pending','leased','retry'))::integer,
    count(*) filter(where state in ('dead','unknown'))::integer into v_pending,v_failed
    from tr8_private.google_jobs where connection_id=c.id and generation=c.generation;
  return jsonb_build_object('configured',v_config,
    'state',case when c.active_provision then 'provisioning' else coalesce(c.state,'disconnected') end,
    'generation',coalesce(c.generation,0),'version',coalesce(c.version,0),'last_sync_at',c.last_sync_at,
    'pending',v_pending,'failed',v_failed,
    'reason',case when not v_config then 'config_pending' when c.active_provision then null else c.reason end);
end; $$;
