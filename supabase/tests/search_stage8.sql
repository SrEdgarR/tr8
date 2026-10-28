-- TEST ONLY. Synthetic search fixtures; every change rolls back.
begin;
select set_config('tr8.search_checks','0',true);
create temporary table search_values(k text primary key,v jsonb) on commit drop;
create temporary table search_existing on commit drop as
 select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
 union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
 union all select 'finances',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create temporary table search_config on commit drop as select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) hash from tr8_private.app_config c;
create function pg_temp.s_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Search assertion: %',label;end if;
 perform set_config('tr8.search_checks',(current_setting('tr8.search_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.s_error(command text,code text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=code then perform pg_temp.s_assert(true,label);return;end if;
  raise exception 'Search expected % got % (%) for %',code,sqlstate,sqlerrm,label;
 end;raise exception 'Search unexpectedly allowed: %',label;
end;$$;
create function pg_temp.s_actor(a uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.s_input(q text default 'Needle',k text default 'all',old boolean default false,o integer default 0,n integer default 5) returns jsonb language sql as $$
 select jsonb_build_object('query',q,'kind',k,'include_archived',old,'offset',o,'limit',n);
$$;
create function pg_temp.s(q text default 'Needle',k text default 'all',old boolean default false,o integer default 0,n integer default 5,w uuid default 'd9680000-0000-4000-8000-000000000001') returns jsonb language sql as $$
 select public.tr8_v2_search(w,pg_temp.s_input(q,k,old,o,n));
$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon,service_role',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update,delete on search_values to authenticated;
grant execute on function pg_temp.s_assert(boolean,text),pg_temp.s_error(text,text,text),pg_temp.s_actor(uuid),pg_temp.s_input(text,text,boolean,integer,integer),pg_temp.s(text,text,boolean,integer,integer,uuid) to authenticated,anon,service_role;

select pg_temp.s_assert(not has_function_privilege('anon','public.tr8_v2_search(uuid,jsonb)','execute'),'anon wrapper denied');
select pg_temp.s_assert(not has_function_privilege('service_role','public.tr8_v2_search(uuid,jsonb)','execute'),'service role cannot impersonate browser');
select pg_temp.s_assert(has_function_privilege('authenticated','public.tr8_v2_search(uuid,jsonb)','execute'),'authenticated wrapper callable');
select pg_temp.s_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_search(uuid,jsonb)'::regprocedure),'public invoker empty search path');
select pg_temp.s_assert((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='tr8_private.global_search(uuid,jsonb)'::regprocedure),'private definer empty search path');
select pg_temp.s_assert(not has_function_privilege('authenticated','tr8_private.search_excerpt(text,text)','execute'),'excerpt helper private');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f9680000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','search-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,6)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'f9680000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Needle search member '||right(id::text,1) from auth.users where id::text like 'f9680000-%';
set local role authenticated;
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000001');
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('d9680000-0000-4000-8000-000000000001','Synthetic search');
select public.tr8_v2_create_project('d9680000-0000-4000-8000-000000000001','a9681001-0001-4000-8000-000000000001','Needle visible project','Visible project description','#5A67D8','active');
select public.tr8_v2_create_project('d9680000-0000-4000-8000-000000000001','a9681002-0002-4000-8000-000000000002','Needle hidden project','Hidden project description','#0284C7','active');
select public.tr8_v2_create_project('d9680000-0000-4000-8000-000000000001','a9681003-0003-4000-8000-000000000003','Needle archived project','Archived project description','#D97706','active');
select public.tr8_v2_create_task('d9680000-0000-4000-8000-000000000001','e9680000-0000-4000-8000-000000000001','a9681001-0001-4000-8000-000000000001','Needle task one','Literal 100%_ and '' OR 1=1 -- plus 😀😀','todo','high',null,null);
select public.tr8_v2_create_task('d9680000-0000-4000-8000-000000000001','e9680000-0000-4000-8000-000000000002','a9681001-0001-4000-8000-000000000001','Other title','Needle context','progress','low',null,null);
select public.tr8_v2_create_task('d9680000-0000-4000-8000-000000000001','e9680000-0000-4000-8000-000000000003','a9681002-0002-4000-8000-000000000002','Needle hidden task','Hidden task body','todo','none',null,null);
select public.tr8_v2_create_task('d9680000-0000-4000-8000-000000000001','e9680000-0000-4000-8000-000000000004','a9681003-0003-4000-8000-000000000003','Needle archived project task','','todo','none',null,null);
select public.tr8_v2_create_task('d9680000-0000-4000-8000-000000000001','e9680000-0000-4000-8000-000000000005','a9681001-0001-4000-8000-000000000001','Needle archived task','','done','none',null,null);
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000004');
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('d9680000-0000-4000-8000-000000000002','Foreign search');
select public.tr8_v2_create_project('d9680000-0000-4000-8000-000000000002','a9681004-0004-4000-8000-000000000004','Needle foreign project','','#D97706','active');
select public.tr8_v2_create_task('d9680000-0000-4000-8000-000000000002','e9680000-0000-4000-8000-000000000006','a9681004-0004-4000-8000-000000000004','Needle foreign task','','todo','none',null,null);
reset role;
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000001');
insert into tr8_private.workspace_members(id,workspace_id,user_id)
 select ('b9680000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d9680000-0000-4000-8000-000000000001',('f9680000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(2,6)n where n<>4;
insert into tr8_private.workspace_roles(id,workspace_id,name) values
 ('09680000-0000-4000-8000-000000000002','d9680000-0000-4000-8000-000000000001','Search reader'),
 ('09680000-0000-4000-8000-000000000003','d9680000-0000-4000-8000-000000000001','Project only'),
 ('09680000-0000-4000-8000-000000000005','d9680000-0000-4000-8000-000000000001','No directory');
insert into tr8_private.role_permissions(workspace_id,role_id,permission)
 select 'd9680000-0000-4000-8000-000000000001',r.id,p from tr8_private.workspace_roles r cross join unnest(array['project.read','task.read','member.read'])p
 where r.id in('09680000-0000-4000-8000-000000000002','09680000-0000-4000-8000-000000000003','09680000-0000-4000-8000-000000000005')
 and not(r.id='09680000-0000-4000-8000-000000000003' and p='task.read') and not(r.id='09680000-0000-4000-8000-000000000005' and p='member.read');
insert into tr8_private.member_roles(workspace_id,member_id,role_id) select workspace_id,('b9680000-0000-4000-8000-'||lpad(right(id::text,1),12,'0'))::uuid,id from tr8_private.workspace_roles where id in('09680000-0000-4000-8000-000000000002','09680000-0000-4000-8000-000000000003','09680000-0000-4000-8000-000000000005');
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
 select 'd9680000-0000-4000-8000-000000000001',p.id,m.id,'read' from public.tr8_workspace_projects p cross join tr8_private.workspace_members m
 where p.id in('a9681001-0001-4000-8000-000000000001','a9681003-0003-4000-8000-000000000003') and m.id in('b9680000-0000-4000-8000-000000000002','b9680000-0000-4000-8000-000000000003','b9680000-0000-4000-8000-000000000005');
update tr8_private.app_users set enabled=false where user_id='f9680000-0000-4000-8000-000000000006';
insert into tr8_private.task_comments(id,workspace_id,task_id,author_id,body)
 select ('c9680000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d9680000-0000-4000-8000-000000000001',
 case when n in(1,2) then 'e9680000-0000-4000-8000-000000000001'::uuid when n=3 then 'e9680000-0000-4000-8000-000000000002'::uuid else ('e9680000-0000-4000-8000-'||lpad((n-1)::text,12,'0'))::uuid end,
 'f9680000-0000-4000-8000-000000000001',case when n=2 then '<img src=x onerror=alert(1)> plain text' when n=3 then repeat('z',300)||'Needle late snippet' else 'Needle comment '||n end from generate_series(1,6)n;
-- Metadata fixtures live in TR8's table only. No Storage object is inserted or modified.
insert into tr8_private.project_files(id,workspace_id,project_id,name,content_type,size,status,object_path,version,created_by,allocated_bytes,delete_from_version)
 select ('c9681000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d9680000-0000-4000-8000-000000000001',
 case when n=3 then 'a9681002-0002-4000-8000-000000000002'::uuid when n=4 then 'a9681003-0003-4000-8000-000000000003'::uuid else 'a9681001-0001-4000-8000-000000000001'::uuid end,
 case when n=1 then 'Needle %_.txt' else 'Needle file '||n||'.txt' end,'text/plain',8,
 case when n=5 then 'pending' when n=6 then 'deleting' else 'ready' end,
 'd9680000-0000-4000-8000-000000000001/'||case when n=3 then 'a9681002-0002-4000-8000-000000000002' when n=4 then 'a9681003-0003-4000-8000-000000000003' else 'a9681001-0001-4000-8000-000000000001' end||'/'||('c9681000-0000-4000-8000-'||lpad(n::text,12,'0')),
 case when n=5 then 1 when n=6 then 3 else 2 end,'f9680000-0000-4000-8000-000000000001',case when n=5 then 5242880 else 8 end,case when n=6 then 2 else null end from generate_series(1,6)n;
update public.tr8_workspace_projects set archived_at=now() where id='a9681003-0003-4000-8000-000000000003';
update public.tr8_workspace_tasks set archived_at=now() where id='e9680000-0000-4000-8000-000000000005';
insert into search_values select 'personal_workspace',to_jsonb(id) from tr8_private.workspaces where kind='personal' and owner_id='f9680000-0000-4000-8000-000000000001';
insert into search_values select 'task_key',to_jsonb(p.code||'-'||t.task_number::text) from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.id=t.project_id where t.id='e9680000-0000-4000-8000-000000000001';

set local role authenticated;
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000001');
insert into search_values values('owner',pg_temp.s());
select pg_temp.s_assert((select v->'counts'='{"project":2,"task":3,"member":4,"file":3,"comment":4}'::jsonb from search_values where k='owner'),'owner exact active visible category counts');
select pg_temp.s_assert((select (select count(*)=7 from jsonb_object_keys(v)) from search_values where k='owner'),'page exact seven fields');
select pg_temp.s_assert((select v->>'workspace_id'='d9680000-0000-4000-8000-000000000001' and v->>'query'='Needle' and v->>'kind'='all' and v->>'include_archived'='false' and v->'next_offset'='null'::jsonb from search_values where k='owner'),'page echoes query and scope exactly');
select pg_temp.s_assert(jsonb_array_length(pg_temp.s('Needle','all',false,0,1)->'items')=5,'all returns balanced one item from every matching category');
select pg_temp.s_assert((select jsonb_agg(e->>'kind' order by ordinal)='["project","task","member","file","comment"]'::jsonb from jsonb_array_elements(pg_temp.s('Needle','all',false,0,1)->'items') with ordinality x(e,ordinal)),'category order stable');
do $$declare e jsonb;begin
 for e in select value from jsonb_array_elements((select v->'items' from search_values where k='owner')) loop
  perform pg_temp.s_assert((select count(*)=17 from jsonb_object_keys(e)),'closed result DTO17');
  perform pg_temp.s_assert(e->>'workspace_id'='d9680000-0000-4000-8000-000000000001','result workspace bound');
  perform pg_temp.s_assert(length(e->>'snippet')<=240 and length(e->>'title') between 1 and 240,'result text bounded');
  perform pg_temp.s_assert(not(e?'email') and not(e?'object_path') and not(e?'body') and not(e?'user_id') and not(e?'owner_id'),'result has no private metadata');
  if e->>'kind'='member' then
   perform pg_temp.s_assert(e->'id'=e->'member_id' and e->'project_id'='null'::jsonb and e->'task_id'='null'::jsonb and e->'project_name'='null'::jsonb and e->>'status'='active','member identity and nullable project fields');
  elsif e->>'kind'='project' then perform pg_temp.s_assert(e->'id'=e->'project_id' and e->'task_id'='null'::jsonb,'project identity');
  elsif e->>'kind'='task' then perform pg_temp.s_assert(e->'id'=e->'task_id' and e->'project_id'<>'null'::jsonb,'task identity');
  elsif e->>'kind'='file' then perform pg_temp.s_assert(e->>'status'='ready' and e->>'content_type'='text/plain' and e->'task_id'='null'::jsonb and e->'author_name'='null'::jsonb,'only file metadata returned');
  elsif e->>'kind'='comment' then
   perform pg_temp.s_assert(e->'task_id'<>'null'::jsonb and e->>'author_name'='Tú','comment points to task with current author presentation');
   perform pg_temp.s_assert(e->'priority'='null'::jsonb and e->'content_type'='null'::jsonb and e->'member_id'='null'::jsonb,'comment projection keeps unrelated nullable fields empty');
  end if;
 end loop;
end;$$;
insert into search_values values('page1',pg_temp.s('Needle','task',false,0,1)),('page2',pg_temp.s('Needle','task',false,1,1)),('page3',pg_temp.s('Needle','task',false,2,1));
select pg_temp.s_assert((select v->>'next_offset'='1' and jsonb_array_length(v->'items')=1 from search_values where k='page1'),'single category first page');
select pg_temp.s_assert((select v->>'next_offset'='2' from search_values where k='page2'),'single category middle page');
select pg_temp.s_assert((select v->'next_offset'='null'::jsonb from search_values where k='page3'),'last page no fabricated next offset');
select pg_temp.s_assert((select count(distinct v->'items'->0->>'id')=3 from search_values where k in('page1','page2','page3')),'no repeated rows across stable pages');
select pg_temp.s_assert(pg_temp.s('Needle','task',false,10000,50)->'items'='[]'::jsonb and pg_temp.s('Needle','task',false,10000,50)->'next_offset'='null'::jsonb,'empty high offset bounded');
select pg_temp.s_assert(pg_temp.s('nEeDlE')->'counts'=(select v->'counts' from search_values where k='owner') and pg_temp.s('nEeDlE')->>'query'='nEeDlE','literal case insensitive preserves query echo');
select pg_temp.s_assert(pg_temp.s('%_','file')->'counts'->>'file'='1','percent underscore treated literally');
select pg_temp.s_assert(pg_temp.s('%%')->'counts'='{"project":0,"task":0,"member":0,"file":0,"comment":0}'::jsonb,'percent is not wildcard');
select pg_temp.s_assert(pg_temp.s('__')->'items'='[]'::jsonb,'underscore is not wildcard');
select pg_temp.s_assert(pg_temp.s(''' OR 1=1 --','task')->'counts'->>'task'='1','SQL punctuation literal, no injected broad query');
select pg_temp.s_assert(pg_temp.s('😀😀','task')->'counts'->>'task'='1','astral Unicode minimum uses codepoints');
select pg_temp.s_assert(pg_temp.s((select v#>>'{}' from search_values where k='task_key'),'task')->'counts'->>'task'='1','task key searchable');
select pg_temp.s_assert(pg_temp.s('late snippet','comment')->'items'->0->>'snippet' like '%Needle late snippet%','snippet includes a late match within body');
select pg_temp.s_assert(pg_temp.s('<img','comment')->'items'->0->>'snippet'='<img src=x onerror=alert(1)> plain text','HTML remains plain text, never generated markup');
select pg_temp.s_assert(pg_temp.s('Needle','all',true)->'counts'='{"project":3,"task":5,"member":4,"file":4,"comment":6}'::jsonb,'include archived explicit and exact');
select pg_temp.s_assert((select bool_and((e->>'archived')::boolean) from jsonb_array_elements(pg_temp.s('archived','all',true)->'items')e),'archive status covers project and task');
select pg_temp.s_assert(pg_temp.s('pending','file',true)->'items'='[]'::jsonb and pg_temp.s('deleting','file',true)->'items'='[]'::jsonb,'unfinished files never searchable');
select pg_temp.s_assert(pg_temp.s('Needle','member',false,0,5,(select (v#>>'{}')::uuid from search_values where k='personal_workspace'))->'counts'->>'member'='0','personal space has no team directory results');
select pg_temp.s_error($q$select pg_temp.s('Needle','all',false,0,5,'d9680000-0000-4000-8000-000000000002')$q$,'PT404','foreign workspace denied');
do $$declare patch jsonb;begin
 for patch in select value from jsonb_array_elements('[{"query":""},{"query":"x"},{"query":" Needle"},{"query":"Needle "},{"query":"  "},{"query":null},{"query":1},{"kind":"finance"},{"kind":null},{"include_archived":null},{"include_archived":"false"},{"offset":-1},{"offset":10001},{"offset":1.5},{"offset":"0"},{"offset":null},{"limit":0},{"limit":51},{"limit":1.5},{"limit":"1"},{"limit":null},{"extra":true}]') loop
  perform pg_temp.s_error(format('select public.tr8_v2_search(%L::uuid,%L::jsonb)','d9680000-0000-4000-8000-000000000001',(pg_temp.s_input()||patch)::text),'22023','closed and bounded input');
 end loop;
end;$$;
select pg_temp.s_error($q$select pg_temp.s('Needle','all',false,1,5)$q$,'22023','all category does not accept unbalanced offset');
select pg_temp.s_error($q$select pg_temp.s(repeat('a',101))$q$,'22023','query maximum codepoints enforced');
select pg_temp.s_error($q$select pg_temp.s('bad'||chr(1))$q$,'22023','C0 controls rejected');
select pg_temp.s_error($q$select pg_temp.s('bad'||chr(127))$q$,'22023','DEL rejected');
select pg_temp.s_error($q$select pg_temp.s('bad'||chr(159))$q$,'22023','C1 controls rejected');
select pg_temp.s_assert(pg_temp.s(repeat(chr(128512),100))->>'query'=repeat(chr(128512),100),'100 astral codepoints accepted');

select pg_temp.s_actor('f9680000-0000-4000-8000-000000000002');
insert into search_values values('reader',pg_temp.s());
select pg_temp.s_assert((select v->'counts'='{"project":1,"task":2,"member":4,"file":2,"comment":3}'::jsonb from search_values where k='reader'),'read only member sees only explicit project access');
select pg_temp.s_assert(pg_temp.s('hidden')->'counts'='{"project":0,"task":0,"member":0,"file":0,"comment":0}'::jsonb,'hidden project metadata has no result or count oracle');
select pg_temp.s_assert((select bool_and(e->>'author_name'='Needle search member 1') from jsonb_array_elements(pg_temp.s('Needle','comment')->'items')e),'directory permission gives current authors');
select pg_temp.s_assert(pg_temp.s('Needle','task')->'counts'=(select v->'counts' from search_values where k='reader'),'counts independent of selected category');
select pg_temp.s_assert(pg_temp.s('Needle','all',true)->'counts'='{"project":2,"task":4,"member":4,"file":3,"comment":5}'::jsonb,'reader can explicitly search readable archives');
select pg_temp.s_assert(pg_temp.s('search-1@example.test')->'items'='[]'::jsonb,'emails not searchable through member results');
select pg_temp.s_assert(pg_temp.s('d9680000-0000-4000-8000-000000000001')->'items'='[]'::jsonb,'storage paths not indexed');

select pg_temp.s_actor('f9680000-0000-4000-8000-000000000003');
select pg_temp.s_assert(pg_temp.s()->'counts'='{"project":1,"task":0,"member":4,"file":2,"comment":0}'::jsonb,'project-only role cannot search tasks or conversations');
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000005');
select pg_temp.s_assert(pg_temp.s()->'counts'='{"project":1,"task":2,"member":0,"file":2,"comment":3}'::jsonb,'no directory permission exposes no member count');
select pg_temp.s_assert((select bool_and(e->>'author_name'='Miembro') from jsonb_array_elements(pg_temp.s('Needle','comment')->'items')e),'author names redact without directory');
select pg_temp.s_assert(pg_temp.s('Needle search member 1','member')->'items'='[]'::jsonb,'name guess cannot bypass directory permission');
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000004');
select pg_temp.s_error($q$select pg_temp.s()$q$,'PT404','nonmember denied even with a live account');
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000006');
select pg_temp.s_error($q$select pg_temp.s()$q$,'42501','disabled app user denied');

reset role;
delete from tr8_private.project_access where workspace_id='d9680000-0000-4000-8000-000000000001' and member_id='b9680000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000002');
select pg_temp.s_assert(pg_temp.s()->'counts'='{"project":0,"task":0,"member":4,"file":0,"comment":0}'::jsonb,'ACL revocation removes rows and counts immediately, directory remains authorized');
reset role;
update tr8_private.workspace_members set status='removed' where id='b9680000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.s_error($q$select pg_temp.s()$q$,'PT404','removed membership cannot search old workspace');
select pg_temp.s_actor('f9680000-0000-4000-8000-000000000001');
reset role;
delete from auth.sessions where user_id='f9680000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.s_error($q$select pg_temp.s()$q$,'42501','terminated browser session denied');
select pg_temp.s_actor(null);
select pg_temp.s_error($q$select pg_temp.s()$q$,'42501','missing actor denied');
reset role;
select pg_temp.s_assert((select hash from search_existing where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where p.id=any((select ids from search_existing where kind='projects')::uuid[])),'existing projects preserved');
select pg_temp.s_assert((select hash from search_existing where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where t.id=any((select ids from search_existing where kind='tasks')::uuid[])),'existing tasks preserved');
select pg_temp.s_assert((select hash from search_existing where kind='finances')=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where f.owner_id=any((select ids from search_existing where kind='finances')::uuid[])),'existing finances preserved');
select pg_temp.s_assert((select hash from search_config)=(select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c),'signup and feature configuration preserved');
select current_setting('tr8.search_checks')::integer as passed_search_checks;
rollback;
