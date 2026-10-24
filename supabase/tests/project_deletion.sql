-- Disposable TEST project only. Synthetic fixtures and changes all roll back.
begin;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select set_config('tr8.delete_checks','0',true);
create temporary table deletion_existing on commit drop as
  select 'projects' kind,coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') body from public.tr8_workspace_projects p
  union all select 'tasks',coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.tr8_workspace_tasks t;
create temporary table deletion_ids(key text primary key,value uuid) on commit drop;
create function pg_temp.d_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Deletion assertion: %',label;end if;
  perform set_config('tr8.delete_checks',(current_setting('tr8.delete_checks')::int+1)::text,true);
end;$$;
create function pg_temp.d_error(statement text,code text,label text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate=code then perform pg_temp.d_assert(true,label);return;end if;
    raise exception 'Deletion assertion: % expected % got % (%)',label,code,sqlstate,sqlerrm;
  end;
  raise exception 'Deletion assertion: % unexpectedly succeeded',label;
end;$$;
create function pg_temp.d_actor(actor uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',coalesce(actor::text,''),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
end;$$;
do $$begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on pg_temp.deletion_ids to authenticated;
grant execute on function pg_temp.d_assert(boolean,text),pg_temp.d_error(text,text,text),pg_temp.d_actor(uuid) to anon,authenticated;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f8d00000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated',
  'tr8-project-delete-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,6)n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f8d00000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,n<>6,'Deletion fixture '||n from generate_series(1,6)n;
set local role authenticated;
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000001');
insert into pg_temp.deletion_ids values('personal',(public.tr8_v2_get_context()->>'personal_workspace_id')::uuid);
select public.tr8_v2_create_team('d8d00000-0000-4000-8000-000000000001','Deletion synthetic team');
select public.tr8_v2_create_project('d8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001','Eliminar SOLO este proyecto','','#5A67D8','active');
select public.tr8_v2_create_project('d8d00000-0000-4000-8000-000000000001','a8d00002-0000-4000-8000-000000000002','Conservar este proyecto','','#5A67D8','active');
select public.tr8_v2_create_project('d8d00000-0000-4000-8000-000000000001','a8d00003-0000-4000-8000-000000000003','Proyecto vacío','','#5A67D8','active');
select public.tr8_v2_create_project('d8d00000-0000-4000-8000-000000000001','a8d00004-0000-4000-8000-000000000004','Proyecto archivado','','#5A67D8','active');
select public.tr8_v2_create_task('d8d00000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001','Child task one','','todo','high',null,null);
select public.tr8_v2_create_task('d8d00000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000002','a8d00001-0000-4000-8000-000000000001','Child task two','','done','none',null,null);
select public.tr8_v2_create_task('d8d00000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000003','a8d00002-0000-4000-8000-000000000002','Unrelated task','','todo','low',null,null);
select public.tr8_v2_update_project('d8d00000-0000-4000-8000-000000000001','a8d00004-0000-4000-8000-000000000004',1,'{"archived_at":"2026-10-24T00:00:00Z"}');
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000002');
insert into pg_temp.deletion_ids values('other-personal',(public.tr8_v2_get_context()->>'personal_workspace_id')::uuid);
select public.tr8_v2_create_project((select value from pg_temp.deletion_ids where key='other-personal'),'a8d00005-0000-4000-8000-000000000005','Other identity project','','#5A67D8','active');
reset role;
-- A member allowed to archive must not silently gain permanent deletion.
insert into tr8_private.workspace_members(id,workspace_id,user_id)
values('b8d00000-0000-4000-8000-000000000003','d8d00000-0000-4000-8000-000000000001','f8d00000-0000-4000-8000-000000000003'),
 ('b8d00000-0000-4000-8000-000000000004','d8d00000-0000-4000-8000-000000000001','f8d00000-0000-4000-8000-000000000004');
insert into tr8_private.workspace_roles(id,workspace_id,name) values('c8d00000-0000-4000-8000-000000000001','d8d00000-0000-4000-8000-000000000001','Archiver only');
insert into tr8_private.role_permissions(workspace_id,role_id,permission)
select 'd8d00000-0000-4000-8000-000000000001','c8d00000-0000-4000-8000-000000000001',p from unnest(array['project.read','task.read','project.archive'])p;
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
select 'd8d00000-0000-4000-8000-000000000001',id,'c8d00000-0000-4000-8000-000000000001' from tr8_private.workspace_members
where id in ('b8d00000-0000-4000-8000-000000000003','b8d00000-0000-4000-8000-000000000004');
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
values('d8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001','b8d00000-0000-4000-8000-000000000003','write'),
 ('d8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001','b8d00000-0000-4000-8000-000000000004','read');
create temporary table deletion_kept on commit drop as select to_jsonb(p) body from public.tr8_workspace_projects p where id='a8d00002-0000-4000-8000-000000000002';
create temporary table deletion_kept_tasks on commit drop as select to_jsonb(t) body from public.tr8_workspace_tasks t where id='e8d00000-0000-4000-8000-000000000003';
-- Provider fixtures are inert metadata inside this rollback-only transaction.
-- No credentials are usable and no worker can see this uncommitted setup.
insert into tr8_private.google_connections(id,user_id,generation,state,calendar_id,credential_envelope,tasks_granted)
values('98d00000-0000-4000-8000-000000000001','f8d00000-0000-4000-8000-000000000001',1,'connected','synthetic-deletion@group.calendar.google.com',
 '{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}',true);
insert into tr8_private.google_tasks_sync(connection_id,generation,enabled,version,workspace_id,project_id)
values('98d00000-0000-4000-8000-000000000001',1,true,1,'d8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001');
insert into tr8_private.google_tasks_lists(connection_id,generation,list_id,title,selected)
values('98d00000-0000-4000-8000-000000000001',1,'synthetic-list','Synthetic deletion list',true);
insert into tr8_private.google_tasks_links(connection_id,generation,list_id,remote_task_id,workspace_id,project_id,local_task_id,local_task_created_at)
select '98d00000-0000-4000-8000-000000000001',1,'synthetic-list','remote-'||id::text,workspace_id,project_id,id,created_at
from public.tr8_workspace_tasks where id in ('e8d00000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000002','e8d00000-0000-4000-8000-000000000003');
do $$begin
  perform pg_temp.d_assert(not has_function_privilege('anon','public.tr8_v2_delete_project(uuid,bigint,text)','EXECUTE'),'anon has no RPC');
  perform pg_temp.d_assert(not has_function_privilege('service_role','public.tr8_v2_delete_project(uuid,bigint,text)','EXECUTE'),'service role cannot bypass user flow');
  perform pg_temp.d_assert(not has_table_privilege('authenticated','public.tr8_workspace_projects','DELETE'),'client has no direct project DELETE');
  perform pg_temp.d_assert(not has_table_privilege('authenticated','public.tr8_workspace_tasks','DELETE'),'client has no direct task DELETE');
  perform pg_temp.d_assert(not (select prosecdef from pg_proc where oid='public.tr8_v2_delete_project(uuid,bigint,text)'::regprocedure),'public wrapper is invoker');
end;$$;
set local role anon;
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto')$q$,'42501','anonymous delete denied');
set local role authenticated;
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000006');
select pg_temp.d_error($q$select public.tr8_v2_delete_project(null,null,null)$q$,'42501','disabled actor rejected before input oracle');
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000005');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto')$q$,'PT404','outsider denied');
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000003');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto')$q$,'PT404','archival permission does not permit permanent delete');
select pg_temp.d_assert(not (public.tr8_v2_get_project_capabilities('d8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001')->'permissions' ? 'project.delete'),'capability hides delete from archiver');
reset role;
insert into tr8_private.role_permissions(workspace_id,role_id,permission)
values('d8d00000-0000-4000-8000-000000000001','c8d00000-0000-4000-8000-000000000001','project.delete');
set local role authenticated;
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000004');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto')$q$,'PT404','delete role with read-only access denied');
select pg_temp.d_assert(not (public.tr8_v2_get_project_capabilities('d8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001')->'permissions' ? 'project.delete'),'read-only project hides delete capability');
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000001');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00005-0000-4000-8000-000000000005',1,'Other identity project')$q$,'PT404','one owner cannot delete another personal project');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',2,'Eliminar SOLO este proyecto')$q$,'PT409','stale version denied');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'eliminar SOLO este proyecto')$q$,'22023','case mismatch denied');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto ')$q$,'22023','extra whitespace denied');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'')$q$,'22023','empty confirmation denied');
select pg_temp.d_assert(public.tr8_v2_get_project_capabilities('d8d00000-0000-4000-8000-000000000001','a8d00001-0000-4000-8000-000000000001')->'permissions' ? 'project.delete','owner receives delete capability');
reset role;
-- Force a failure after children have been deleted: the entire operation must
-- roll back, including its task outbox and activity, not leave partial damage.
create function pg_temp.d_fail_project() returns trigger language plpgsql as $$
begin if old.id='a8d00001-0000-4000-8000-000000000001' then raise exception using errcode='P0001',message='Synthetic final-delete failure';end if;return old;end;$$;
create trigger synthetic_delete_failure before delete on public.tr8_workspace_projects for each row execute function pg_temp.d_fail_project();
set local role authenticated;
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto')$q$,'P0001','late failure rolls back transaction');
reset role;
do $$begin
  perform pg_temp.d_assert((select count(*)=2 from public.tr8_workspace_tasks where project_id='a8d00001-0000-4000-8000-000000000001'),'failed delete preserves both children');
  perform pg_temp.d_assert(exists(select 1 from tr8_private.project_access where project_id='a8d00001-0000-4000-8000-000000000001'),'failed delete preserves access');
  perform pg_temp.d_assert(not exists(select 1 from tr8_private.process_outbox where project_id='a8d00001-0000-4000-8000-000000000001' and event_kind like '%.deleted'),'failed delete leaves no committed cleanup work');
  perform pg_temp.d_assert(not exists(select 1 from tr8_private.google_tasks_jobs where connection_id='98d00000-0000-4000-8000-000000000001'),'failed delete leaves no provider cleanup job');
end;$$;
drop trigger synthetic_delete_failure on public.tr8_workspace_projects;
set local role authenticated;
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000003');
select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto');
select pg_temp.d_actor('f8d00000-0000-4000-8000-000000000001');
select public.tr8_v2_delete_project('a8d00003-0000-4000-8000-000000000003',1,'Proyecto vacío');
select public.tr8_v2_delete_project('a8d00004-0000-4000-8000-000000000004',2,'Proyecto archivado');
select pg_temp.d_error($q$select public.tr8_v2_delete_project('a8d00001-0000-4000-8000-000000000001',1,'Eliminar SOLO este proyecto')$q$,'PT404','deleted project cannot be deleted again');
reset role;
do $$begin
  perform pg_temp.d_assert(not exists(select 1 from public.tr8_workspace_projects where id in ('a8d00001-0000-4000-8000-000000000001','a8d00003-0000-4000-8000-000000000003','a8d00004-0000-4000-8000-000000000004')),'only selected fixture projects deleted');
  perform pg_temp.d_assert(not exists(select 1 from public.tr8_workspace_tasks where project_id='a8d00001-0000-4000-8000-000000000001'),'children removed');
  perform pg_temp.d_assert(not exists(select 1 from tr8_private.project_access where project_id='a8d00001-0000-4000-8000-000000000001'),'project access removed');
  perform pg_temp.d_assert(not exists(select 1 from tr8_private.workspace_activity where project_id='a8d00001-0000-4000-8000-000000000001'),'private activity never becomes unscoped');
  perform pg_temp.d_assert((select count(*)=2 from tr8_private.process_outbox where project_id='a8d00001-0000-4000-8000-000000000001' and event_kind='task.deleted'),'task cleanup outbox retained exactly once per child');
  perform pg_temp.d_assert((select count(*)=1 from tr8_private.process_outbox where project_id='a8d00001-0000-4000-8000-000000000001' and event_kind='project.deleted'),'project cleanup outbox retained');
  perform pg_temp.d_assert((select count(*)=1 from tr8_private.workspace_activity where project_id is null and action='project.deleted' and resource_id='a8d00001-0000-4000-8000-000000000001'),'minimal deletion audit retained');
  perform pg_temp.d_assert((select count(*)=2 from tr8_private.google_tasks_links where connection_id='98d00000-0000-4000-8000-000000000001' and state='deleting'),'linked child tasks retain deletion intent');
  perform pg_temp.d_assert((select count(*)=2 from tr8_private.google_tasks_jobs where connection_id='98d00000-0000-4000-8000-000000000001' and kind='delete' and state='pending'),'only the two linked child tasks queue provider deletion');
  perform pg_temp.d_assert((select state='synced' and revision=1 from tr8_private.google_tasks_links where local_task_id='e8d00000-0000-4000-8000-000000000003'),'unrelated Google task link unchanged');
  perform pg_temp.d_assert(exists(select 1 from tr8_private.google_jobs where connection_id='98d00000-0000-4000-8000-000000000001' and kind='reconcile_scan'),'Calendar reconciliation intent retained');
  perform pg_temp.d_assert((select to_jsonb(p)=k.body from public.tr8_workspace_projects p cross join pg_temp.deletion_kept k where p.id='a8d00002-0000-4000-8000-000000000002'),'unrelated same-workspace project unchanged');
  perform pg_temp.d_assert((select to_jsonb(t)=k.body from public.tr8_workspace_tasks t cross join pg_temp.deletion_kept_tasks k where t.id='e8d00000-0000-4000-8000-000000000003'),'unrelated task unchanged');
  perform pg_temp.d_assert(exists(select 1 from public.tr8_workspace_projects where id='a8d00005-0000-4000-8000-000000000005'),'other identity project unchanged');
  perform pg_temp.d_assert((select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]')=(select body from pg_temp.deletion_existing where kind='projects') from public.tr8_workspace_projects p where id::text not like 'a8d0000%'),'all original projects byte-equivalent');
  perform pg_temp.d_assert((select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')=(select body from pg_temp.deletion_existing where kind='tasks') from public.tr8_workspace_tasks t where id::text not like 'e8d00000-%'),'all original tasks byte-equivalent');
  perform pg_temp.d_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external onboarding remains closed');
end;$$;
-- A subsequent new provider task creates a fresh personal destination instead
-- of remaining stuck on the deleted project's ID. Old links are not rebound.
do $$declare result jsonb; destination uuid; imported uuid; project_count bigint;begin
  perform pg_temp.d_assert(not exists(select 1 from public.tr8_workspace_projects where id='a8d00001-0000-4000-8000-000000000001'),'deleted import destination stays deleted before the next import');
  result:=tr8_private.v6_observe('98d00000-0000-4000-8000-000000000001','synthetic-list',
    '{"id":"synthetic-after-project-delete","etag":"after-delete-etag","title":"New task after destination deletion","completed":false,"start_date":null,"deleted":false,"assigned":false}');
  select project_id,local_task_id into destination,imported from tr8_private.google_tasks_links
    where connection_id='98d00000-0000-4000-8000-000000000001' and remote_task_id='synthetic-after-project-delete';
  perform pg_temp.d_assert(imported is not null and destination<>'a8d00001-0000-4000-8000-000000000001','new import receives a different destination');
  perform pg_temp.d_assert(exists(select 1 from public.tr8_workspace_tasks where id=imported and project_id=destination),'new task is actually persisted');
  perform pg_temp.d_assert((select s.project_id=destination and s.workspace_id=w.id from tr8_private.google_tasks_sync s
    join tr8_private.workspaces w on w.id=s.workspace_id where s.connection_id='98d00000-0000-4000-8000-000000000001' and w.kind='personal' and w.owner_id='f8d00000-0000-4000-8000-000000000001'),'binding repaired to the same user personal space');
  perform pg_temp.d_assert((select count(*)=2 from tr8_private.google_tasks_links where project_id='a8d00001-0000-4000-8000-000000000001' and state='deleting'),'previous deletion intents never move to the new project');
  perform tr8_private.v6_observe('98d00000-0000-4000-8000-000000000001','synthetic-list',
    '{"id":"synthetic-after-project-delete","etag":"after-delete-etag","title":"New task after destination deletion","completed":false,"start_date":null,"deleted":false,"assigned":false}');
  perform pg_temp.d_assert((select count(*)=1 from tr8_private.google_tasks_links where connection_id='98d00000-0000-4000-8000-000000000001' and remote_task_id='synthetic-after-project-delete'),'repeated import creates no duplicate');
  select count(*) into project_count from public.tr8_workspace_projects;
  perform public.tr8_v2_update_project((select value from pg_temp.deletion_ids where key='personal'),destination,1,jsonb_build_object('archived_at',clock_timestamp()::text));
  result:=tr8_private.v6_ensure_import_project('98d00000-0000-4000-8000-000000000001');
  perform pg_temp.d_assert(result->>'project_id'=destination::text,'archived destination binding is preserved');
  perform pg_temp.d_assert((select count(*)=project_count from public.tr8_workspace_projects),'archival never creates a replacement project');
  result:=tr8_private.v6_observe('98d00000-0000-4000-8000-000000000001','synthetic-list',
    '{"id":"synthetic-while-project-archived","etag":"archived-etag","title":"Deferred while archived","completed":false,"start_date":null,"deleted":false,"assigned":false}');
  perform pg_temp.d_assert(result->>'reason'='project_archived' and not exists(select 1 from tr8_private.google_tasks_links where remote_task_id='synthetic-while-project-archived'),'new imports respect archival instead of bypassing it');
end;$$;
select current_setting('tr8.delete_checks')::integer as project_deletion_assertions;
rollback;
