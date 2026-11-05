-- TEST ONLY. Synthetic fixtures and all changes roll back.
begin;
select set_config('tr8.recurrence_window_checks','0',true);
create function pg_temp.rw_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Recurrence window assertion: %',label;end if;
 perform set_config('tr8.recurrence_window_checks',(current_setting('tr8.recurrence_window_checks')::integer+1)::text,true);
end;$$;

create temporary table recurrence_window_cases (
 label text primary key, id uuid not null default gen_random_uuid(),
 initial_start date, initial_due date not null, current_start date, current_due date,
 rule jsonb not null, expected_start date, expected_due date, terminal_reason text
) on commit drop;

with civil as (select (clock_timestamp() at time zone 'America/La_Paz')::date d),
 fixtures(label,initial_start,initial_due,current_start,current_due,frequency,n,weekdays,ending,expected_start,expected_due,reason) as (
 select f.* from civil cross join lateral (values
  ('edited duration skips elapsed starts',d-1,d-1,d-5,d,'daily',1,'[]'::jsonb,null::date,d+1,d+6,null::text),
  ('later due date skips earlier anchored slots',null,d-2,null,d+9,'daily',3,'[]',null,null,d+10,null),
  ('cleared start stays empty',d-7,d-1,null,d-1,'daily',1,'[]',null,null,d+1,null),
  ('cleared due date does not copy a stale duration',d-7,d-1,d-7,null,'daily',1,'[]',null,null,d+1,null),
  ('weekly interval skips a window starting today',d-28,d-14,d-28,d-14,'weekly',2,jsonb_build_array(extract(isodow from d)::integer),null,d+14,d+28,null),
  ('monthly interval still clamps the original day',date '2090-12-22',date '2090-12-31',date '2090-12-22',date '2090-12-31',
   'monthly',2,'[]',null,date '2091-02-19',date '2091-02-28',null),
  ('eligible due date may equal inclusive ending',d-3,d-1,d-3,d-1,'daily',1,'[]',d+3,d+1,d+3,null),
  ('ending excludes a window starting today',d-3,d-1,d-3,d-1,'daily',1,'[]',d+2,null,null,'until_reached'),
  ('last supported due date is allowed',null,date '9999-12-30',null,date '9999-12-30','daily',1,'[]',null,null,date '9999-12-31',null),
  ('a duration beyond the supported calendar finishes safely',date '0001-01-01',date '9999-12-30',date '0001-01-01',date '9999-12-30',
   'daily',1,'[]',null,null,null,'date_limit')
 ) f
)
insert into recurrence_window_cases(label,initial_start,initial_due,current_start,current_due,rule,expected_start,expected_due,terminal_reason)
select label,initial_start,initial_due,current_start,current_due,
 jsonb_build_object('frequency',frequency,'interval',n,'weekdays',weekdays,'time_zone','America/La_Paz','until_date',ending),expected_start,expected_due,reason
from fixtures;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('fa120000-0000-4000-8000-000000000001','authenticated','authenticated','recurrence-window@example.test',now(),'{}','{}',now(),now());
insert into auth.sessions(id,user_id,created_at,updated_at)
 values('fa120000-0000-4000-8000-000000000001','fa120000-0000-4000-8000-000000000001',now(),now());
insert into tr8_private.app_users(user_id,enabled,display_name)
 values('fa120000-0000-4000-8000-000000000001',true,'Synthetic recurrence window');
grant select on recurrence_window_cases to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','fa120000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"fa120000-0000-4000-8000-000000000001","role":"authenticated","session_id":"fa120000-0000-4000-8000-000000000001"}',true);
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('da120000-0000-4000-8000-000000000001','Synthetic recurrence window');
select public.tr8_v2_create_project('da120000-0000-4000-8000-000000000001','aa120000-0000-4000-8000-000000000001',
 'Synthetic recurrence window','','#5A67D8','active');
select public.tr8_v2_create_task('da120000-0000-4000-8000-000000000001',id,'aa120000-0000-4000-8000-000000000001',
 label,'','todo','none',initial_start,initial_due) from recurrence_window_cases;
select public.tr8_v2_recurrence(t.workspace_id,'save',jsonb_build_object('id',t.id,'project_id',t.project_id,'created_at',t.created_at,
 'task_version',t.version,'series_version',null,'request_id',gen_random_uuid(),'rule',c.rule))
 from public.tr8_workspace_tasks t join recurrence_window_cases c on c.id=t.id;
select public.tr8_v2_update_task(t.workspace_id,t.id,t.version,jsonb_build_object('start_date',c.current_start,'due_date',c.current_due))
 from public.tr8_workspace_tasks t join recurrence_window_cases c on c.id=t.id
 where (t.start_date,t.due_date) is distinct from (c.current_start,c.current_due);
select public.tr8_v2_update_task(t.workspace_id,t.id,t.version,'{"status":"done"}')
 from public.tr8_workspace_tasks t join recurrence_window_cases c on c.id=t.id;
reset role;

select pg_temp.rw_assert(t.status='done' and o.processed,c.label||': completion and ledger commit')
 from recurrence_window_cases c left join public.tr8_workspace_tasks t on t.id=c.id
 left join tr8_private.task_recurrence_occurrences o on o.task_id=t.id and o.task_created_at=t.created_at;
select pg_temp.rw_assert(
 case when c.expected_due is null then s.state='finished' and s.reason=c.terminal_reason and o.successor_task_id is null
  else s.state='active' and child.status='todo' and child.due_date=c.expected_due and child.start_date is not distinct from c.expected_start
   and s.start_offset is not distinct from (c.expected_start-c.expected_due) and s.current_occurrence_date=c.expected_due
   and (s.current_task_id,s.current_task_created_at)=(child.id,child.created_at)
   and next_occurrence.occurrence_date=c.expected_due and not next_occurrence.processed
 end,c.label||': expected successor and current series state')
 from recurrence_window_cases c
 left join tr8_private.task_recurrence_occurrences o on o.task_id=c.id
 left join tr8_private.task_recurrence_series s on s.id=o.series_id
 left join public.tr8_workspace_tasks child on (child.id,child.created_at)=(o.successor_task_id,o.successor_task_created_at)
 left join tr8_private.task_recurrence_occurrences next_occurrence on (next_occurrence.task_id,next_occurrence.task_created_at)=(child.id,child.created_at);

create temporary table recurrence_window_before_replay on commit drop as
 select c.id,o.successor_task_id,s.version from recurrence_window_cases c
 join tr8_private.task_recurrence_occurrences o on o.task_id=c.id join tr8_private.task_recurrence_series s on s.id=o.series_id;
set local role authenticated;
select public.tr8_v2_update_task(t.workspace_id,t.id,t.version,'{"status":"todo"}')
 from public.tr8_workspace_tasks t join recurrence_window_cases c on c.id=t.id;
select public.tr8_v2_update_task(t.workspace_id,t.id,t.version,'{"status":"done"}')
 from public.tr8_workspace_tasks t join recurrence_window_cases c on c.id=t.id;
reset role;
select pg_temp.rw_assert(
 o.successor_task_id is not distinct from b.successor_task_id and s.version=b.version
 and (select count(*) from tr8_private.task_recurrence_occurrences q where q.series_id=s.id)=case when c.expected_due is null then 1 else 2 end,
 c.label||': recompletion does not generate another occurrence')
 from recurrence_window_cases c
 left join recurrence_window_before_replay b on b.id=c.id
 left join tr8_private.task_recurrence_occurrences o on o.task_id=c.id
 left join tr8_private.task_recurrence_series s on s.id=o.series_id;
select current_setting('tr8.recurrence_window_checks')::integer as recurrence_window_checks;
rollback;
