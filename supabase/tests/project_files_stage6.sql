-- TEST ONLY: synthetic private metadata, no Storage object INSERT/UPDATE/DELETE.
-- Real object bytes and Storage RLS are tested separately through its API.
-- Execute on tr8-test only; all fixtures and mutations roll back.
begin;
select set_config('tr8.files_checks','0',true);
create temporary table files_values(k text primary key,v jsonb) on commit drop;
create temporary table files_existing on commit drop as
 select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
 union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
 union all select 'finances',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create temporary table files_config on commit drop as select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) hash from tr8_private.app_config c;
create function pg_temp.f_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Project files assertion: %',label;end if;
 perform set_config('tr8.files_checks',(current_setting('tr8.files_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.f_error(command text,code text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=code then perform pg_temp.f_assert(true,label);return;end if;
  raise exception 'Files expected % got % (%) for %',code,sqlstate,sqlerrm,label;
 end;raise exception 'Files unexpectedly allowed: %',label;
end;$$;
create function pg_temp.f_actor(a uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.f(a text,i jsonb default '{}') returns jsonb language sql as $$select public.tr8_v2_project_files('d9660000-0000-4000-8000-000000000001',a,i);$$;
create function pg_temp.f_reserve(r uuid,p uuid default 'a9661001-0001-4000-8000-000000000001',bytes bigint default 3) returns jsonb language sql as $$
 select jsonb_build_object('id',r,'project_id',p,'name','notes.txt','content_type','text/plain','size',bytes);
$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on files_values to authenticated;
grant execute on function pg_temp.f_assert(boolean,text),pg_temp.f_error(text,text,text),pg_temp.f_actor(uuid),pg_temp.f(text,jsonb),pg_temp.f_reserve(uuid,uuid,bigint) to authenticated,anon;

select pg_temp.f_assert(not has_function_privilege('anon','public.tr8_v2_project_files(uuid,text,jsonb)','execute'),'anonymous RPC denied');
select pg_temp.f_assert(not has_function_privilege('service_role','public.tr8_v2_project_files(uuid,text,jsonb)','execute'),'service role cannot impersonate browser');
select pg_temp.f_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_project_files(uuid,text,jsonb)'::regprocedure),'public wrapper invoker with empty search_path');
select pg_temp.f_assert((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='tr8_private.project_files(uuid,text,jsonb)'::regprocedure),'private authorization gateway with empty search_path');
select pg_temp.f_assert((select bool_and(relrowsecurity) from pg_class where oid in('tr8_private.project_files'::regclass,'tr8_private.project_file_receipts'::regclass)),'private metadata and receipts have RLS');
select pg_temp.f_assert(not has_table_privilege('authenticated','tr8_private.project_files','select') and not has_table_privilege('authenticated','tr8_private.project_file_receipts','insert'),'direct metadata and receipts denied');
select pg_temp.f_assert(not has_table_privilege('service_role','tr8_private.project_files','update'),'service role cannot directly alter file state');
select pg_temp.f_assert((select not public and file_size_limit=5242880 and cardinality(allowed_mime_types)=10 from storage.buckets where id='tr8-project-files'),'private bucket has 5MiB and type restrictions');
select pg_temp.f_assert((select count(*)=3 from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'tr8_project_files_%'),'only three supported bucket policies');
select pg_temp.f_assert(not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'tr8_project_files_%' and cmd in('ALL','UPDATE')),'upsert and update have no policy');
select pg_temp.f_assert((select qual like '%object.get_authenticated%' and qual like '%object.delete_many%' and qual not like '%object.sign%' and qual not like '%object.list%' and qual not like '%object.move%' and qual not like '%object.copy%' from pg_policies where schemaname='storage' and policyname='tr8_project_files_select'),'read policy excludes signed URLs, lists, moves and copies');
select pg_temp.f_assert((select with_check like '%object.upload%' and with_check like '%metadata%' from pg_policies where schemaname='storage' and policyname='tr8_project_files_insert'),'insert checks managed operation and actual metadata');
select pg_temp.f_assert(tr8_private.project_file_fields('Informe.PDF','application/pdf') and tr8_private.project_file_fields('Notas.csv','text/csv'),'canonical types accept coherent extensions');
select pg_temp.f_assert(not tr8_private.project_file_fields('../evil.txt','text/plain') and not tr8_private.project_file_fields(E'bad\\evil.txt','text/plain') and not tr8_private.project_file_fields(E'bad\n.txt','text/plain'),'paths and control characters denied');
select pg_temp.f_assert(not tr8_private.project_file_fields('evil.svg','image/svg+xml') and not tr8_private.project_file_fields('index.html','text/html') and not tr8_private.project_file_fields('wrong.zip','image/png'),'active or mismatched type denied');
select pg_temp.f_assert(not tr8_private.project_file_fields('.pdf','application/pdf') and not tr8_private.project_file_fields('.txt','text/plain'),'extension-only names are not a basename');
select pg_temp.f_assert(not tr8_private.project_file_fields('bad'||chr(128)||'.txt','text/plain') and not tr8_private.project_file_fields('bad'||chr(159)||'.txt','text/plain'),'C1 controls are rejected independently of locale');
select pg_temp.f_assert(tr8_private.project_file_fields(repeat(chr(128512),176)||'.txt','text/plain') and not tr8_private.project_file_fields(repeat(chr(128512),177)||'.txt','text/plain'),'Unicode limit counts code points consistently with the client');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f9660000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','files-stage6-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,4)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'f9660000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Synthetic files user' from auth.users where id::text like 'f9660000-%';
set local role authenticated;
select pg_temp.f_actor('f9660000-0000-4000-8000-000000000001');
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('d9660000-0000-4000-8000-000000000001','Synthetic files workspace');
select public.tr8_v2_create_team('d9660000-0000-4000-8000-000000000002','Synthetic foreign files workspace');
select public.tr8_v2_create_project('d9660000-0000-4000-8000-000000000001','a9661001-0001-4000-8000-000000000001','Files primary','','#5A67D8','active');
select public.tr8_v2_create_project('d9660000-0000-4000-8000-000000000001','a9661002-0002-4000-8000-000000000002','Files hidden','','#5A67D8','active');
select public.tr8_v2_create_project('d9660000-0000-4000-8000-000000000001','a9661003-0003-4000-8000-000000000003','Files quota three','','#5A67D8','active');
select public.tr8_v2_create_project('d9660000-0000-4000-8000-000000000001','a9661004-0004-4000-8000-000000000004','Files quota four','','#5A67D8','active');
select public.tr8_v2_create_project('d9660000-0000-4000-8000-000000000001','a9661005-0005-4000-8000-000000000005','Files quota five','','#5A67D8','active');
select public.tr8_v2_create_project('d9660000-0000-4000-8000-000000000002','a9661006-0006-4000-8000-000000000006','Other workspace','','#5A67D8','active');
insert into files_values values('initial',pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}'));
select pg_temp.f_assert((select v from files_values where k='initial')='{"items":[],"used_bytes":0,"max_bytes":52428800,"max_file_bytes":5242880,"max_files":100}'::jsonb,'new project starts empty with bounded project-only quota');
insert into files_values values('reserved',pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000001')));
select pg_temp.f_assert((select v->>'status'='pending' and (v->>'size')::integer=3 and (v->>'version')::integer=1 and v->>'created_by'='f9660000-0000-4000-8000-000000000001' from files_values where k='reserved'),'reservation has server managed identity state and quota');
select pg_temp.f_assert((select (select count(*) from jsonb_object_keys(v))=11 and not(v?'delete_from_version') and not(v?'allocated_bytes') from files_values where k='reserved'),'DTO has exact public fields without deletion or allocation internals');
select pg_temp.f_assert((pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->>'used_bytes')::bigint=5242880,'pending upload reserves the full bucket maximum, even for three declared bytes');
select pg_temp.f_assert(pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000001'))=(select v from files_values where k='reserved'),'exact reservation retry does not duplicate');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000001')||'{"size":4}')$q$,'PT409','request UUID binds original name type size and project');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000002')||'{"unknown":true}')$q$,'22023','closed reservation DTO');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000002')||'{"size":0}')$q$,'22023','empty upload denied');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000002')||'{"size":5242881}')$q$,'22023','file above 5MiB denied');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000002')||'{"size":"3"}')$q$,'22023','text numeric size denied');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000002')||'{"name":"wrong.svg"}')$q$,'22023','extension is bound to MIME');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000002','a9661006-0006-4000-8000-000000000006'))$q$,'PT404','cannot reserve in foreign workspace');
select pg_temp.f_error($q$select pg_temp.f('complete','{"id":"c9660000-0000-4000-8000-000000000001"}')$q$,'55000','metadata is not ready without an API object');
select pg_temp.f_error($q$select pg_temp.f('rename','{"id":"c9660000-0000-4000-8000-000000000001","version":1,"name":"new.txt"}')$q$,'55000','incomplete uploads cannot be renamed');
select pg_temp.f_assert(tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload','{"size":3,"mimetype":"text/plain"}'),'upload helper accepts exact reserved metadata');
select pg_temp.f_assert(tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload','{"contentLength":3,"mimetype":"text/plain"}'),'managed preflight metadata is admitted before measured size is available');
select pg_temp.f_assert(tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload',null),'legacy managed empty preflight is admitted only for an authorized pending reservation');
select pg_temp.f_assert(not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload','{"contentLength":3,"mimetype":"image/png"}'),'preflight still rejects a supplied wrong MIME');
select pg_temp.f_assert(not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload','{"size":5242880,"mimetype":"text/plain"}'),'policy helper rejects a supplied measured size mismatch; API finalization is verified separately');
select pg_temp.f_assert(not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload','{"size":3,"mimetype":"image/png"}'),'actual MIME mismatch denied');
select pg_temp.f_assert(not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'read'),'pending object cannot be downloaded');
select pg_temp.f_assert(not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'delete'),'unprepared delete denied');

reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id) values
 ('b9660000-0000-4000-8000-000000000002','d9660000-0000-4000-8000-000000000001','f9660000-0000-4000-8000-000000000002'),
 ('b9660000-0000-4000-8000-000000000003','d9660000-0000-4000-8000-000000000001','f9660000-0000-4000-8000-000000000003');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
 select workspace_id,case when template_key='collaborator' then 'b9660000-0000-4000-8000-000000000002'::uuid else 'b9660000-0000-4000-8000-000000000003'::uuid end,id
 from tr8_private.workspace_roles where workspace_id='d9660000-0000-4000-8000-000000000001' and template_key in('collaborator','read');
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values
 ('d9660000-0000-4000-8000-000000000001','a9661001-0001-4000-8000-000000000001','b9660000-0000-4000-8000-000000000002','write'),
 ('d9660000-0000-4000-8000-000000000001','a9661001-0001-4000-8000-000000000001','b9660000-0000-4000-8000-000000000003','read');
set local role authenticated;
select pg_temp.f_actor('f9660000-0000-4000-8000-000000000002');
select pg_temp.f_assert(jsonb_array_length(pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->'items')=1,'authorized collaborator sees file metadata');
select pg_temp.f_error($q$select pg_temp.f('list','{"project_id":"a9661002-0002-4000-8000-000000000002"}')$q$,'PT404','workspace membership does not grant hidden project file list');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000001'))$q$,'PT409','another actor cannot reuse upload reservation');
select pg_temp.f_assert(not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload','{"size":3,"mimetype":"text/plain"}'),'only reservation creator can upload its bytes');
select pg_temp.f_error($q$select pg_temp.f('complete','{"id":"c9660000-0000-4000-8000-000000000001"}')$q$,'PT404','collaborator cannot complete another upload');
select pg_temp.f_actor('f9660000-0000-4000-8000-000000000003');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000002'))$q$,'PT404','read-only membership cannot upload');
select pg_temp.f_error($q$select pg_temp.f('begin_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":1}')$q$,'PT404','read-only membership cannot remove files');

-- Synthetic ready state in TR8-owned metadata only, to exercise rename/CAS.
-- This is not a claim that Storage contains a corresponding object.
reset role;
update tr8_private.project_files set status='ready',allocated_bytes=size,version=2 where id='c9660000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.f_assert(tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'read'),'read-only user may download a ready file');
select pg_temp.f_error($q$select pg_temp.f('rename','{"id":"c9660000-0000-4000-8000-000000000001","version":2,"name":"renamed.txt"}')$q$,'PT404','read-only member cannot rename');
select pg_temp.f_actor('f9660000-0000-4000-8000-000000000002');
insert into files_values values('renamed',pg_temp.f('rename','{"id":"c9660000-0000-4000-8000-000000000001","version":2,"name":"renamed.txt"}'));
select pg_temp.f_assert((select v->>'name'='renamed.txt' and (v->>'version')::integer=3 and v->>'object_path'=(select v->>'object_path' from files_values where k='reserved') from files_values where k='renamed'),'rename changes display name and version without moving bytes');
select pg_temp.f_error($q$select pg_temp.f('rename','{"id":"c9660000-0000-4000-8000-000000000001","version":2,"name":"stale.txt"}')$q$,'PT409','stale rename cannot overwrite');
select pg_temp.f_error($q$select pg_temp.f('rename','{"id":"c9660000-0000-4000-8000-000000000001","version":3,"name":"new.pdf"}')$q$,'22023','rename preserves file MIME extension');

reset role;
delete from tr8_private.project_access where workspace_id='d9660000-0000-4000-8000-000000000001' and member_id='b9660000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.f_error($q$select pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')$q$,'PT404','revoked project ACL cannot list existing metadata');
select pg_temp.f_error($q$select tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'read')$q$,'PT404','revoked ACL cannot download existing file');
select pg_temp.f_actor('f9660000-0000-4000-8000-000000000001');
reset role;
update public.tr8_workspace_projects set archived_at=now() where id='a9661001-0001-4000-8000-000000000001';
set local role authenticated;
select pg_temp.f_assert(jsonb_array_length(pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->'items')=1,'archive preserves file listing');
select pg_temp.f_assert(tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'read'),'archive preserves authenticated read');
select pg_temp.f_error($q$select pg_temp.f('begin_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":3}')$q$,'55000','archive prevents file deletion until restore');
reset role;
update public.tr8_workspace_projects set archived_at=null where id='a9661001-0001-4000-8000-000000000001';
set local role authenticated;
select pg_temp.f_error($q$select public.tr8_v2_delete_project('a9661001-0001-4000-8000-000000000001',(select version from public.tr8_workspace_projects where id='a9661001-0001-4000-8000-000000000001'),'Files primary')$q$,'PT422','project deletion cannot orphan reserved or ready files');
insert into files_values values('deleting',pg_temp.f('begin_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":3}'));
select pg_temp.f_assert((select v->>'status'='deleting' and (v->>'version')::integer=4 from files_values where k='deleting'),'delete starts a versioned tombstone ticket');
select pg_temp.f_assert(pg_temp.f('begin_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":3}')=(select v from files_values where k='deleting') and pg_temp.f('begin_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":4}')=(select v from files_values where k='deleting'),'original and ticket versions replay same deletion');
select pg_temp.f_assert((pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->>'used_bytes')::integer=3,'deleting still consumes reserved quota');
select pg_temp.f_assert(not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'read') and not tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'upload','{"size":3,"mimetype":"text/plain"}'),'deleting denies new downloads and uploads');
select pg_temp.f_assert(tr8_private.project_file_storage_access((select v->>'object_path' from files_values where k='reserved'),'delete'),'prepared delete may pass Storage delete helper');
select pg_temp.f_error($q$select pg_temp.f('finish_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":3}')$q$,'PT409','finish requires current deletion ticket');
select pg_temp.f_assert(pg_temp.f('finish_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":4}')='{"id":"c9660000-0000-4000-8000-000000000001","deleted":true}'::jsonb,'finish releases only an absent object');
select pg_temp.f_assert(pg_temp.f('finish_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":4}')->>'deleted'='true' and pg_temp.f('begin_delete','{"id":"c9660000-0000-4000-8000-000000000001","version":3}')->>'deleted'='true','lost delete acknowledgements replay safely');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000001'))$q$,'PT409','deleted upload UUID can never resurrect');
select pg_temp.f_assert((pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->>'used_bytes')::integer=0,'confirmed absence releases quota');

select pg_temp.f('reserve',pg_temp.f_reserve('c9660000-0000-4000-8000-000000000009'));
select pg_temp.f('begin_delete','{"id":"c9660000-0000-4000-8000-000000000009","version":1}');
select pg_temp.f_assert((pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->>'used_bytes')::bigint=5242880,'cancelling an unconfirmed upload retains its full 5 MiB allocation');
select pg_temp.f('finish_delete','{"id":"c9660000-0000-4000-8000-000000000009","version":2}');
select pg_temp.f_assert((pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->>'used_bytes')::bigint=0,'pending cancellation releases allocation only after confirmed absence');

-- Simulate confirmed small records in TR8-owned metadata only; no binary is
-- uploaded. Each reservation first consumes a full 5 MiB slot, as in production.
-- Only a successful size-validated complete can release that excess normally.
reset role;
do $$declare n integer;fid uuid;ticket jsonb;begin
 for n in 1..100 loop
  fid:=('c9660001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  perform pg_temp.f('reserve',pg_temp.f_reserve(fid,'a9661001-0001-4000-8000-000000000001',1));
  update tr8_private.project_files set status='ready',allocated_bytes=size,version=2 where project_files.id=fid;
 end loop;
 perform pg_temp.f_assert((pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->>'used_bytes')::integer=100,'confirmed small files are charged at measured size');
 perform pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660001-0000-4000-8000-000000000101','a9661001-0001-4000-8000-000000000001',1))$q$,'PT413','100 file project cap enforced');
 for n in 1..100 loop
  fid:=('c9660001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  ticket:=pg_temp.f('begin_delete',jsonb_build_object('id',fid,'version',2));
  perform pg_temp.f('finish_delete',jsonb_build_object('id',fid,'version',(ticket->>'version')::integer));
 end loop;
end;$$;
set local role authenticated;
do $$declare n integer;j integer;id uuid;p uuid;begin
 for j in 1..4 loop
  p:=case j when 1 then 'a9661001-0001-4000-8000-000000000001'::uuid when 2 then 'a9661002-0002-4000-8000-000000000002'::uuid when 3 then 'a9661003-0003-4000-8000-000000000003'::uuid else 'a9661004-0004-4000-8000-000000000004'::uuid end;
  for n in 1..10 loop
   id:=('c9660002-0000-4000-8000-'||lpad((j*100+n)::text,12,'0'))::uuid;
   perform pg_temp.f('reserve',pg_temp.f_reserve(id,p,5242880));
  end loop;
  perform pg_temp.f_assert((pg_temp.f('list',jsonb_build_object('project_id',p))->>'used_bytes')::bigint=52428800,'50MiB boundary reserved per project');
 end loop;
 perform pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660002-0000-4000-8000-000000000999','a9661001-0001-4000-8000-000000000001',1))$q$,'PT413','project quota includes all pending bytes');
 perform pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9660002-0000-4000-8000-000000000999','a9661005-0005-4000-8000-000000000005',1))$q$,'PT413','global quota stops extra reservations without disclosing hidden usage');
 perform pg_temp.f_assert(not(pg_temp.f('list','{"project_id":"a9661005-0005-4000-8000-000000000005"}')?'global_bytes'),'global storage usage is not exposed');
end;$$;

-- Resolve the pending quota fixtures through the normal deletion protocol.
-- No object exists for these metadata-only uploads.
do $$declare q record;ticket jsonb;begin
 for q in select value from jsonb_array_elements(pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->'items') loop
  ticket:=pg_temp.f('begin_delete',jsonb_build_object('id',q.value->>'id','version',(q.value->>'version')::integer));
  perform pg_temp.f('finish_delete',jsonb_build_object('id',ticket->>'id','version',(ticket->>'version')::integer));
 end loop;
end;$$;
do $$declare p uuid;q record;ticket jsonb;begin
 foreach p in array array['a9661002-0002-4000-8000-000000000002'::uuid,'a9661003-0003-4000-8000-000000000003'::uuid,'a9661004-0004-4000-8000-000000000004'::uuid] loop
  for q in select value from jsonb_array_elements(pg_temp.f('list',jsonb_build_object('project_id',p))->'items') loop
   ticket:=pg_temp.f('begin_delete',jsonb_build_object('id',q.value->>'id','version',(q.value->>'version')::integer));
   perform pg_temp.f('finish_delete',jsonb_build_object('id',ticket->>'id','version',(ticket->>'version')::integer));
  end loop;
 end loop;
end;$$;
reset role;
-- Fill only TR8-owned minimal tombstones to one below lifetime admission cap.
-- The insertion trigger remains enabled even for this synthetic bulk fixture.
insert into tr8_private.project_file_receipts(id,workspace_id,project_id,created_by,payload_hash,deleted_version,delete_from_version)
 select ('c9661000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d9660000-0000-4000-8000-000000000001','a9661001-0001-4000-8000-000000000001',
 'f9660000-0000-4000-8000-000000000001',repeat('a',64),2,1 from generate_series(1,9999-(select count(*)::integer from tr8_private.project_file_receipts)) n;
select pg_temp.f_assert((select count(*) from tr8_private.project_file_receipts)=9999,'synthetic tombstones reach lifetime boundary with admission trigger enabled');
set local role authenticated;
insert into files_values values('lifetime',pg_temp.f('reserve',pg_temp.f_reserve('c9669999-0000-4000-8000-000000000001')));
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9669999-0000-4000-8000-000000000002'))$q$,'PT413','lifetime cap blocks new UUID even with free byte and file capacity');
select pg_temp.f_assert(pg_temp.f('reserve',pg_temp.f_reserve('c9669999-0000-4000-8000-000000000001'))=(select v from files_values where k='lifetime'),'existing reservation replay still succeeds at lifetime cap');
select pg_temp.f_assert(jsonb_array_length(pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')->'items')=1,'failed receipt admission rolls back the corresponding metadata reservation');
select pg_temp.f('begin_delete','{"id":"c9669999-0000-4000-8000-000000000001","version":1}');
select pg_temp.f('finish_delete','{"id":"c9669999-0000-4000-8000-000000000001","version":2}');
select pg_temp.f_assert(pg_temp.f('finish_delete','{"id":"c9669999-0000-4000-8000-000000000001","version":2}')->>'deleted'='true','confirmed deletion replay succeeds at lifetime cap');
select pg_temp.f_error($q$select pg_temp.f('reserve',pg_temp.f_reserve('c9669999-0000-4000-8000-000000000002'))$q$,'PT413','deletion frees bytes but does not recycle lifetime admission');

select pg_temp.f_actor(null);
select pg_temp.f_error($q$select pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')$q$,'42501','a browser session is required independently of grants');
reset role;
select pg_temp.f_actor('f9660000-0000-4000-8000-000000000001');
delete from auth.sessions where id='f9660000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.f_error($q$select pg_temp.f('list','{"project_id":"a9661001-0001-4000-8000-000000000001"}')$q$,'42501','terminated browser session cannot list project files');
reset role;
select pg_temp.f_assert((select hash from files_existing where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where p.id in(select unnest(ids) from files_existing where kind='projects')),'preexisting projects preserved byte-for-byte');
select pg_temp.f_assert((select hash from files_existing where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where t.id in(select unnest(ids) from files_existing where kind='tasks')),'preexisting tasks preserved byte-for-byte');
select pg_temp.f_assert((select hash from files_existing where kind='finances')=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where f.owner_id in(select unnest(ids) from files_existing where kind='finances')),'existing financial documents preserved');
select pg_temp.f_assert((select hash from files_config)=(select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c),'signup and account settings preserved');
select current_setting('tr8.files_checks')::integer as passed_stage6_file_assertions;
rollback;
