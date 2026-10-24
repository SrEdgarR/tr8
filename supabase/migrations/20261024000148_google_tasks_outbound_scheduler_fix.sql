-- Correct only the scheduler's ambiguous table alias; existing intents and
-- provider identities remain untouched. CREATE OR REPLACE preserves the ACL.
create temporary table tr8_stage6b_scheduler_snapshot on commit drop as select
  (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p) projects,
  (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t) tasks,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) app_config,
  (select proacl::text from pg_proc where oid='tr8_private.v6_queue_due()'::regprocedure) function_acl,
  (select proowner from pg_proc where oid='tr8_private.v6_queue_due()'::regprocedure) function_owner;

create or replace function tr8_private.v6_queue_due()
returns integer language plpgsql volatile security definer set search_path='' as $$
declare s record; z record; v_count integer:=0;
begin
  if not exists(select 1 from tr8_private.google_config where singleton and configured and scheduler_enabled) then return 0;end if;
  for s in select a.* from tr8_private.google_tasks_sync a join tr8_private.google_connections c on c.id=a.connection_id
    where a.enabled and a.generation=c.generation and c.state='connected' and c.tasks_granted
      and (a.next_pull_at is null or a.next_pull_at<=clock_timestamp())
    order by a.connection_id limit 100 for no key update of c skip locked loop
    if exists(select 1 from tr8_private.google_tasks_lists l where l.connection_id=s.connection_id and l.generation=s.generation) then
      for z in select list_id from tr8_private.google_tasks_lists where connection_id=s.connection_id and generation=s.generation and selected loop
        if not exists(select 1 from tr8_private.google_tasks_jobs j where j.connection_id=s.connection_id and j.generation=s.generation and j.kind='pull' and j.list_id=z.list_id and j.state in ('pending','retry','leased')) then
          perform tr8_private.v6_enqueue(s.connection_id,'pull',null,z.list_id);v_count:=v_count+1;
        end if;
      end loop;
    elsif not exists(select 1 from tr8_private.google_tasks_jobs j where j.connection_id=s.connection_id and j.generation=s.generation and j.kind='discover' and j.state in ('pending','retry','leased')) then
      perform tr8_private.v6_enqueue(s.connection_id,'discover');v_count:=v_count+1;
    end if;
    update tr8_private.google_tasks_sync set next_pull_at=clock_timestamp()+interval '15 minutes' where connection_id=s.connection_id;
  end loop;
  for z in select l.id,l.connection_id,l.list_id from tr8_private.google_tasks_links l
    join tr8_private.google_connections c on c.id=l.connection_id and c.generation=l.generation and c.state='connected' and c.tasks_granted
    join tr8_private.google_tasks_sync sync_row on sync_row.connection_id=c.id and sync_row.generation=c.generation and sync_row.enabled
    join tr8_private.google_tasks_lists list_row on list_row.connection_id=c.id and list_row.generation=c.generation and list_row.list_id=l.list_id and list_row.selected
    where l.origin='tr8' and l.remote_task_id is not null and l.state in ('synced','dirty') and not l.cleanup_requested
      and tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is not null
      and not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at) loop
    update tr8_private.google_tasks_links set cleanup_requested=true,state='deleting' where id=z.id;
    perform tr8_private.v6_enqueue(z.connection_id,'delete',z.id,z.list_id);
  end loop;
  return v_count;
end; $$;

do $stage6b_scheduler_preservation$
declare s record;
begin
  select * into strict s from pg_temp.tr8_stage6b_scheduler_snapshot;
  if s.projects is distinct from (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p)
    or s.tasks is distinct from (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t)
    or s.app_config is distinct from (select to_jsonb(c) from tr8_private.app_config c where singleton)
    or s.function_acl is distinct from (select proacl::text from pg_proc where oid='tr8_private.v6_queue_due()'::regprocedure)
    or s.function_owner is distinct from (select proowner from pg_proc where oid='tr8_private.v6_queue_due()'::regprocedure) then
    raise exception 'Scheduler alias correction unexpectedly changed domain data, signup, ownership or grants';
  end if;
end; $stage6b_scheduler_preservation$;
