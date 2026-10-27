-- Current-schema visual identity regression. Synthetic TEST fixtures only.
-- All content, role and quota changes are rolled back. Never run in production.
begin;
select set_config('request.jwt.claim','',true);
select set_config('request.jwt.claims','{}',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('tr8.visual_checks','0',true);
create temporary table visual_values(k text primary key,v jsonb) on commit drop;
create temporary table visual_before on commit drop as
select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) digest,array_agg(id) ids from public.tr8_workspace_projects p
union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
union all select 'finance',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create function pg_temp.visual_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Visual identity assertion failed: %',label; end if;
  perform set_config('tr8.visual_checks',(current_setting('tr8.visual_checks')::int+1)::text,true);
end;$$;
create function pg_temp.visual_actor(a uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim','',true);
  perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
  perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.visual_error(command text,expected text,label text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate=expected then perform pg_temp.visual_assert(true,label); return; end if;
    raise exception 'Visual identity assertion failed: %; expected %, got %',label,expected,sqlstate;
  end;
  raise exception 'Visual identity assertion failed: %; unexpectedly allowed',label;
end;$$;
create function pg_temp.visual_workspace() returns uuid language sql as $$select (v->>'personal_workspace_id')::uuid from pg_temp.visual_values where k='owner';$$;
do $$begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on pg_temp.visual_values to anon,authenticated;
grant execute on function pg_temp.visual_assert(boolean,text),pg_temp.visual_actor(uuid),pg_temp.visual_error(text,text,text),pg_temp.visual_workspace() to anon,authenticated;

select pg_temp.visual_assert((select attnotnull and atthasdef from pg_attribute where attrelid='public.tr8_workspace_projects'::regclass and attname='icon'),'icon is nonnullable and defaults for old clients');
select pg_temp.visual_assert((select relrowsecurity from pg_class where oid='public.tr8_workspace_projects'::regclass),'project RLS remains enabled');
select pg_temp.visual_assert(not has_function_privilege('anon','public.tr8_v2_create_project_with_icon(uuid,uuid,text,text,text,text,text)','execute'),'anonymous create RPC denied');
select pg_temp.visual_assert(not has_function_privilege('service_role','public.tr8_v2_create_project_with_icon(uuid,uuid,text,text,text,text,text)','execute'),'service role does not gain browser RPC');
select pg_temp.visual_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_create_project_with_icon(uuid,uuid,text,text,text,text,text)'::regprocedure),'public wrapper stays invoker with pinned search path');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f9200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','visual-identity-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,2)n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select id,true,'Synthetic visual identity' from auth.users where id::text like 'f9200000-%';
insert into auth.sessions(id,user_id,created_at,updated_at)
select id,id,now(),now() from auth.users where id::text like 'f9200000-%';
set local role authenticated;
select pg_temp.visual_actor('f9200000-0000-4000-8000-000000000001');
insert into visual_values values('owner',public.tr8_v2_get_context());
insert into visual_values values('project',to_jsonb(public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001','Synthetic visual project','','#5A67D8','active','rocket')));
select pg_temp.visual_assert((select v->>'icon'='rocket' and v->>'version'='1' from visual_values where k='project'),'new icon persists atomically at version one');
select pg_temp.visual_assert((public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001','Synthetic visual project','','#5A67D8','active','rocket')).version=1,'exact creation retry is idempotent');
select pg_temp.visual_error($q$select public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001','Synthetic visual project','','#5A67D8','active','heart')$q$,'PT409','changed icon cannot reuse creation request');
select pg_temp.visual_assert((public.tr8_v2_create_project(pg_temp.visual_workspace(),'f9201001-0000-4000-8000-000000000002','Synthetic old client','','#5A67D8','active')).icon='folder','old create clients keep folder default');
select pg_temp.visual_assert((public.tr8_v2_create_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001','Synthetic visual project','','#5A67D8','active')).icon='rocket','legacy exact retry preserves new icon');
select pg_temp.visual_assert((public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',1,'{"icon":"globe"}')).version=2,'icon edit uses normal project version');
select pg_temp.visual_assert((select icon='globe' from public.tr8_workspace_projects where id='f9201000-0000-4000-8000-000000000001'),'owner reads persisted icon');
select pg_temp.visual_error($q$select public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',1,'{"icon":"heart"}')$q$,'PT409','stale icon cannot overwrite new version');
select pg_temp.visual_assert((public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',2,'{"description":"Safe edit"}')).icon='globe','old updates preserve current icon');
select pg_temp.visual_error($q$select public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',3,'{"icon":null}')$q$,'22023','null icon rejected');
select pg_temp.visual_error($q$select public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',3,'{"icon":5}')$q$,'22023','numeric icon rejected');
select pg_temp.visual_error($q$select public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',3,'{"icon":"heart","owner_id":"f9200000-0000-4000-8000-000000000002"}')$q$,'22023','icon patch does not admit server-managed fields');
select pg_temp.visual_error($q$select public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',3,'{"icon":"<svg onload=alert(1)>"}')$q$,'22023','raw markup cannot become icon');
select pg_temp.visual_error($q$select public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201002-0000-4000-8000-000000000003','Invalid','','#5A67D8','active','https://example.test/icon.svg')$q$,'22023','remote icon URLs rejected');
select pg_temp.visual_error($q$select public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201002-0000-4000-8000-000000000003','Invalid','','#5A67D8','active',null)$q$,'22023','null create icon rejected');
select pg_temp.visual_error($q$update public.tr8_workspace_projects set icon='heart' where id='f9201000-0000-4000-8000-000000000001'$q$,'42501','direct icon writes remain denied');
insert into visual_values values('key',public.tr8_mcp_credentials('create',jsonb_build_object('workspace_id',pg_temp.visual_workspace(),'name','Synthetic visual identity','access','write','expires_in_days',7)));
insert into visual_values values('read_key',public.tr8_mcp_credentials('create',jsonb_build_object('workspace_id',pg_temp.visual_workspace(),'name','Synthetic visual read','access','read','expires_in_days',7)));
reset role;
select pg_temp.visual_assert((select count(*)=1 from tr8_private.workspace_activity where resource_id='f9201000-0000-4000-8000-000000000001' and action='project.created'),'retry does not duplicate creation activity');
set local role anon;
select pg_temp.visual_actor(null);
insert into visual_values values('mcp',public.tr8_mcp_dispatch((select v->>'token' from visual_values where k='key'),'get_project','{"id":"f9201000-0000-4000-8000-000000000001"}'));
select pg_temp.visual_assert((select v->>'icon'='globe' from visual_values where k='mcp'),'MCP reads new icon through original tool contract');
insert into visual_values values('mcp_update',public.tr8_mcp_dispatch((select v->>'token' from visual_values where k='key'),'update_project','{"id":"f9201000-0000-4000-8000-000000000001","version":3,"patch":{"name":"Synthetic MCP edit"}}'));
select pg_temp.visual_assert((select v->>'icon'='globe' and v->>'version'='4' from visual_values where k='mcp_update'),'MCP update preserves icon and version semantics');
insert into visual_values values('read_denied',public.tr8_mcp_dispatch((select v->>'token' from visual_values where k='read_key'),'update_project','{"id":"f9201000-0000-4000-8000-000000000001","version":4,"patch":{"name":"Denied read-only MCP"}}'));
select pg_temp.visual_assert((select v#>>'{_tr8_mcp_error,code}'='PT403' from visual_values where k='read_denied'),'read-only MCP credential cannot write project identity');
select pg_temp.visual_error($q$select public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201002-0000-4000-8000-000000000003','Denied','','#5A67D8','active','heart')$q$,'42501','anonymous browser RPC denied');
reset role;
set local role authenticated;
select pg_temp.visual_actor('f9200000-0000-4000-8000-000000000002');
insert into visual_values values('other',public.tr8_v2_get_context());
select pg_temp.visual_assert((select count(*)=0 from public.tr8_workspace_projects where id='f9201000-0000-4000-8000-000000000001'),'other account cannot read project icon');
select pg_temp.visual_error($q$select public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',4,'{"icon":"heart"}')$q$,'PT404','other account cannot change project icon');
select pg_temp.visual_error($q$select public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201002-0000-4000-8000-000000000003','Denied','','#5A67D8','active','heart')$q$,'PT404','icon create cannot target another account workspace');
select pg_temp.visual_actor('f9200000-0000-4000-8000-000000000001');
insert into visual_values values('team',public.tr8_v2_create_team('f9203000-0000-4000-8000-000000000001','Synthetic visual team'));
select pg_temp.visual_assert((public.tr8_v2_create_project_with_icon('f9203000-0000-4000-8000-000000000001','f9201003-0000-4000-8000-000000000004','Synthetic shared project','','#5A67D8','active','palette')).icon='palette','team owner can create project identity');
reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id)
values('f9204000-0000-4000-8000-000000000001','f9203000-0000-4000-8000-000000000001','f9200000-0000-4000-8000-000000000002');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
select workspace_id,'f9204000-0000-4000-8000-000000000001',id from tr8_private.workspace_roles
where workspace_id='f9203000-0000-4000-8000-000000000001' and template_key='read';
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
values('f9203000-0000-4000-8000-000000000001','f9201003-0000-4000-8000-000000000004','f9204000-0000-4000-8000-000000000001','read');
set local role authenticated;
select pg_temp.visual_actor('f9200000-0000-4000-8000-000000000002');
select pg_temp.visual_assert((select icon='palette' from public.tr8_workspace_projects where id='f9201003-0000-4000-8000-000000000004'),'project reader sees the permitted project icon');
select pg_temp.visual_error($q$select public.tr8_v2_update_project('f9203000-0000-4000-8000-000000000001','f9201003-0000-4000-8000-000000000004',1,'{"icon":"heart"}')$q$,'PT404','read-only project member cannot edit icon');
select pg_temp.visual_error($q$select public.tr8_v2_create_project_with_icon('f9203000-0000-4000-8000-000000000001','f9201004-0000-4000-8000-000000000005','Denied reader create','','#5A67D8','active','heart')$q$,'PT404','reader cannot bypass create permission via icon RPC');
select pg_temp.visual_actor('f9200000-0000-4000-8000-000000000001');
do $$declare icons text[]:=array['globe','smartphone','megaphone','rocket','component','building-2','layout-grid','palette','code','briefcase','target','layers','zap','heart','folder','sparkles']; i integer;begin
  for i in 1..array_length(icons,1) loop
    perform pg_temp.visual_assert((public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),('f921'||lpad(i::text,4,'0')||'-0000-4000-8000-000000000001')::uuid,'Synthetic icon '||icons[i],'','#5A67D8','active',icons[i])).icon=icons[i],'allowlisted icon roundtrip '||icons[i]);
  end loop;
end;$$;
select pg_temp.visual_assert((public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',4,'{"archived_at":"2026-10-27T00:00:00Z"}')).icon='globe','archive preserves icon');
select pg_temp.visual_assert((public.tr8_v2_update_project(pg_temp.visual_workspace(),'f9201000-0000-4000-8000-000000000001',5,'{"icon":"heart"}')).archived_at is not null,'existing archived-project metadata editing semantics are preserved');
reset role;
delete from auth.sessions where id='f9200000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.visual_error($q$select public.tr8_v2_create_project_with_icon(pg_temp.visual_workspace(),'f9201002-0000-4000-8000-000000000003','Denied','','#5A67D8','active','heart')$q$,'42501','revoked session cannot create icons');
select pg_temp.visual_assert((select count(*)=0 from public.tr8_workspace_projects),'revoked session cannot enumerate icons');
reset role;
select pg_temp.visual_assert((select b.digest=md5(coalesce((jsonb_agg(to_jsonb(p) order by p.id) filter(where p.id is not null))::text,'')) from visual_before b left join public.tr8_workspace_projects p on p.id=any(b.ids) where b.kind='projects' group by b.digest),'pre-existing projects preserved');
select pg_temp.visual_assert((select b.digest=md5(coalesce((jsonb_agg(to_jsonb(t) order by t.id) filter(where t.id is not null))::text,'')) from visual_before b left join public.tr8_workspace_tasks t on t.id=any(b.ids) where b.kind='tasks' group by b.digest),'pre-existing tasks preserved');
select pg_temp.visual_assert((select b.digest=md5(coalesce((jsonb_agg(to_jsonb(f) order by f.owner_id) filter(where f.owner_id is not null))::text,'')) from visual_before b left join tr8_private.account_finances f on f.owner_id=any(b.ids) where b.kind='finance' group by b.digest),'pre-existing finance preserved');
select jsonb_build_object('checks',current_setting('tr8.visual_checks')::int,'result','passed') as visual_identity_test_result;
rollback;
