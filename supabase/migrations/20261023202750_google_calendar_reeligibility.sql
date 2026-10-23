-- Stage 5 follow-up: a confirmed-deleted copy may become eligible again when
-- dates, assignment or access return. Allocate a fresh remote incarnation;
-- Google tombstones must never receive a second insert with their old ID.
-- remote_missing remains an explicit user-controlled rebuild.
create or replace function tr8_private.v5_scan(p_job uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_jobs; c tr8_private.google_connections; t public.tr8_workspace_tasks;
  k record; l record; v_count integer:=0; v_last uuid; v_link uuid; v_hash text;
begin
  select * into strict j from tr8_private.google_jobs where id=p_job;
  select * into strict c from tr8_private.google_connections where id=j.connection_id;
  for k in select q.task_id from(
      select t0.id task_id from public.tr8_workspace_tasks t0
        join tr8_private.workspaces w on w.id=t0.workspace_id
        left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=t0.assignee_member_id
        where (w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id)
      union select task_id from tr8_private.google_event_links where connection_id=c.id and generation=c.generation
    ) q where j.cursor_id is null or q.task_id>j.cursor_id order by q.task_id limit 100 loop
    v_count:=v_count+1;v_last:=k.task_id;
    select * into t from public.tr8_workspace_tasks where id=k.task_id;
    if found and tr8_private.v5_task_eligible(c.id,t.id,t.created_at) then
      v_hash:=tr8_private.v5_task_hash(t.id);
      insert into tr8_private.google_event_links(connection_id,generation,workspace_id,project_id,task_id,task_created_at,desired_hash)
        values(c.id,c.generation,t.workspace_id,t.project_id,t.id,t.created_at,v_hash)
        on conflict(connection_id,generation,task_id,task_created_at) do nothing;
      select id into v_link from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and task_id=t.id and task_created_at=t.created_at;
      -- Only confirmed deletions are eligible for an automatic new copy. Keep
      -- the prior ID as a tombstone and retain the stable TR8 link identity.
      update tr8_private.google_event_links set retired_event_ids=array_append(retired_event_ids,event_id),
        event_id=replace(gen_random_uuid()::text,'-',''),state='pending',synced_hash=null,cleanup_not_before=null,
        updated_at=clock_timestamp() where id=v_link and state='deleted';
      update tr8_private.google_event_links set desired_hash=v_hash,updated_at=clock_timestamp() where id=v_link;
      if exists(select 1 from tr8_private.google_event_links where id=v_link and state in ('pending','synced') and synced_hash is distinct from v_hash) then
        perform tr8_private.v5_enqueue(c.id,'upsert',v_link);
      end if;
    end if;
    for l in select * from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and task_id=k.task_id
      and state not in ('deleted','retained') loop
      if not tr8_private.v5_task_eligible(c.id,l.task_id,l.task_created_at) then
        update tr8_private.google_event_links set state='deleting',updated_at=clock_timestamp() where id=l.id;
        perform tr8_private.v5_enqueue(c.id,'delete',l.id);
      end if;
    end loop;
  end loop;
  update tr8_private.google_jobs set cursor_id=coalesce(v_last,cursor_id),scan_more=v_count=100 where id=p_job;
  return jsonb_build_object('internal',true,'scanned',v_count,'more',v_count=100);
end; $$;
