-- Advance from the completed task's current dates, preserving its current
-- duration while keeping the successor's start and due dates after completion.
-- Existing series, occurrences, identities, permissions and receipts stay intact.
begin;
create or replace function tr8_private.recurrence_generate(t public.tr8_workspace_tasks) returns void
language plpgsql volatile security definer set search_path='' as $$
declare s tr8_private.task_recurrence_series;o tr8_private.task_recurrence_occurrences;
 next_date date;next_start date;child public.tr8_workspace_tasks;assignee uuid;why text;today date;current_start_offset integer;
begin
 select q.* into s from tr8_private.task_recurrence_series q
  where q.current_task_id=t.id and q.current_task_created_at=t.created_at for update;
 if not found or s.state<>'active' or s.workspace_id<>t.workspace_id or s.project_id<>t.project_id or t.archived_at is not null or t.status<>'done' then return;end if;
 select * into o from tr8_private.task_recurrence_occurrences q where q.task_id=t.id and q.task_created_at=t.created_at for update;
 if not found or o.series_id<>s.id or o.processed then return;end if;
 if not tr8_private.v7_domain_permission(s.workspace_id,s.project_id,s.author_id,'task.edit')
  or not tr8_private.v7_domain_permission(s.workspace_id,s.project_id,s.author_id,'task.create') then
  update tr8_private.task_recurrence_series set state='blocked',reason='authority_lost',version=version+1,updated_at=clock_timestamp() where id=s.id;
  return;
 end if;
 today:=(clock_timestamp() at time zone s.time_zone)::date;
 -- A reschedule edits the current occurrence, including its duration. Derive
 -- the next window from those live dates instead of the originally saved span.
 if t.start_date between date '0001-01-01' and date '9999-12-31'
  and t.due_date between date '0001-01-01' and date '9999-12-31' and t.start_date<=t.due_date then
  current_start_offset:=t.start_date-t.due_date;
 end if;
 -- Google Tasks projects start_date. Skipping only elapsed due dates could
 -- therefore create an occurrence scheduled today or in the past. Raising
 -- this due-date cutoff retains the cadence and the complete current duration.
 -- PostgreSQL date arithmetic supports the temporary cutoff beyond year 9999;
 -- recurrence_next_date returns null for it without creating an invalid task.
 next_date:=tr8_private.recurrence_next_date(s.anchor_date,s.frequency,s.interval_count,s.weekdays,s.until_date,
  greatest(o.occurrence_date,t.due_date,today,today-coalesce(current_start_offset,0)));
 if next_date is null then
  update tr8_private.task_recurrence_occurrences set processed=true where task_id=t.id and task_created_at=t.created_at;
  update tr8_private.task_recurrence_series set state='finished',reason=case when s.until_date is not null then 'until_reached' else 'date_limit' end,
   version=version+1,updated_at=clock_timestamp() where id=s.id;
  return;
 end if;
 if t.assignee_member_id is not null then
  if tr8_private.v7_domain_permission(s.workspace_id,s.project_id,s.author_id,'task.assign')
   and tr8_private.v2_assignee_eligible(s.workspace_id,s.project_id,t.assignee_member_id) then assignee:=t.assignee_member_id;
  else why:='assignee_not_inherited';end if;
 end if;
 if current_start_offset is not null then next_start:=next_date+current_start_offset;end if;
 -- Assignee is present in the original INSERT: Google capture must not see an
 -- intermediate unassigned task. Blocks are intentionally not copied in v1.
 insert into public.tr8_workspace_tasks(id,workspace_id,owner_id,project_id,title,description,status,priority,start_date,due_date,
  assignee_member_id,labels,estimate_minutes,subtasks)
 values(gen_random_uuid(),s.workspace_id,s.author_id,s.project_id,t.title,t.description,'todo',t.priority,next_start,next_date,assignee,
  t.labels,t.estimate_minutes,coalesce((select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'title',x.value->>'title','done',false) order by x.ordinality)
   from jsonb_array_elements(t.subtasks) with ordinality x(value,ordinality)),'[]'::jsonb)) returning * into child;
 insert into tr8_private.task_recurrence_occurrences(task_id,task_created_at,series_id,occurrence_date) values(child.id,child.created_at,s.id,next_date);
 update tr8_private.task_recurrence_occurrences set processed=true,successor_task_id=child.id,successor_task_created_at=child.created_at
  where task_id=t.id and task_created_at=t.created_at;
 update tr8_private.task_recurrence_series set current_task_id=child.id,current_task_created_at=child.created_at,
  current_occurrence_date=next_date,start_offset=current_start_offset,reason=why,version=version+1,updated_at=clock_timestamp() where id=s.id;
 insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
  values(s.workspace_id,s.project_id,s.author_id,'task.created',child.id);
end;$$;

commit;


