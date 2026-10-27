-- Synthetic TEST fixtures only. Never run this suite against production.
begin;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select set_config('tr8.productivity_checks','0',true);
create temporary table prod_values(k text primary key,v jsonb) on commit drop;
create temporary table prod_existing on commit drop as
select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
union all select 'finance',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create function pg_temp.p_assert(ok boolean,label text) returns void language plpgsql as $$begin
  if ok is distinct from true then raise exception 'Productivity assertion: %',label;end if;
  perform set_config('tr8.productivity_checks',(current_setting('tr8.productivity_checks')::int+1)::text,true);
end;$$;
create function pg_temp.p_actor(a uuid) returns void language plpgsql as $$begin
  perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
  perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.p_error(command text,code text,label text) returns void language plpgsql as $$begin
  begin execute command;exception when others then
    if sqlstate=code then perform pg_temp.p_assert(true,label);return;end if;
    raise exception 'Productivity assertion: % expected % got % (%)',label,code,sqlstate,sqlerrm;
  end;raise exception 'Productivity assertion: % unexpectedly allowed',label;
end;$$;
create function pg_temp.p(action text,input jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select public.tr8_v2_productivity('d9300000-0000-4000-8000-000000000001',action,input);
$$;
create function pg_temp.cfg() returns jsonb language sql as $$select v from pg_temp.prod_values where k='config';$$;
create function pg_temp.order_items() returns jsonb language sql as $$select v from pg_temp.prod_values where k='order';$$;
do $$begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on pg_temp.prod_values to authenticated;
grant execute on function pg_temp.p_assert(boolean,text),pg_temp.p_actor(uuid),pg_temp.p_error(text,text,text),pg_temp.p(text,jsonb),pg_temp.cfg(),pg_temp.order_items() to anon,authenticated;

select pg_temp.p_assert(not has_function_privilege('anon','public.tr8_v2_productivity(uuid,text,jsonb)','execute'),'anonymous RPC denied');
select pg_temp.p_assert(not has_function_privilege('service_role','public.tr8_v2_productivity(uuid,text,jsonb)','execute'),'service role does not gain browser preferences');
select pg_temp.p_assert(has_function_privilege('authenticated','public.tr8_v2_productivity(uuid,text,jsonb)','execute'),'signed in browser wrapper granted');
select pg_temp.p_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_productivity(uuid,text,jsonb)'::regprocedure),'public entry stays invoker');
select pg_temp.p_assert((select count(*)=3 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='tr8_private' and c.relname in ('productivity_favorites','productivity_views','productivity_reorders') and relrowsecurity),'all new private tables have RLS');
select pg_temp.p_assert(not has_table_privilege('authenticated','tr8_private.productivity_views','select'),'private table reads denied');
select pg_temp.p_assert(not has_table_privilege('authenticated','tr8_private.productivity_favorites','insert'),'private favorite writes denied');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f9300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','productivity-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,3)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'f9300000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Synthetic productivity' from auth.users where id::text like 'f9300000-%';
insert into prod_values values('config','{"schemaVersion":1,"view":"table","query":"","statuses":[],"priorities":[],"projectIds":[],"assigneeIds":[],"due":"all","sort":"manual","direction":"asc","group":"none","columns":["status","priority","due_date"],"favoritesOnly":false}');
set local role authenticated;
select pg_temp.p_actor('f9300000-0000-4000-8000-000000000001');
insert into prod_values values('owner',public.tr8_v2_get_context());
select public.tr8_v2_create_team('d9300000-0000-4000-8000-000000000001','Synthetic productivity team');
select public.tr8_v2_create_project('d9300000-0000-4000-8000-000000000001','a9301001-0000-4000-8000-000000000001','Synthetic project A','','#5A67D8','active');
select public.tr8_v2_create_project('d9300000-0000-4000-8000-000000000001','a9301002-0000-4000-8000-000000000002','Synthetic project B','','#3B82C4','active');
select public.tr8_v2_create_task('d9300000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001','a9301001-0000-4000-8000-000000000001','Synthetic task A1','','todo','high',null,null);
select public.tr8_v2_create_task('d9300000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000002','a9301001-0000-4000-8000-000000000001','Synthetic task A2','','progress','low',null,null);
select public.tr8_v2_create_task('d9300000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000003','a9301002-0000-4000-8000-000000000002','Synthetic task B1','','todo','none',null,null);
insert into prod_values values('fixture_task_before',to_jsonb((select t from public.tr8_workspace_tasks t where id='e9300000-0000-4000-8000-000000000001')));
select pg_temp.p_actor('f9300000-0000-4000-8000-000000000002');
select public.tr8_v2_get_context();
reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id) values('b9300000-0000-4000-8000-000000000002','d9300000-0000-4000-8000-000000000001','f9300000-0000-4000-8000-000000000002');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
select workspace_id,'b9300000-0000-4000-8000-000000000002',id from tr8_private.workspace_roles where workspace_id='d9300000-0000-4000-8000-000000000001' and template_key='read';
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values('d9300000-0000-4000-8000-000000000001','a9301001-0000-4000-8000-000000000001','b9300000-0000-4000-8000-000000000002','read');
set local role authenticated;
select pg_temp.p_actor('f9300000-0000-4000-8000-000000000001');
select pg_temp.p_assert(pg_temp.p('load')='{"favorites":[],"views":[]}'::jsonb,'new preferences are empty, never backfilled fake data');
select pg_temp.p_assert(pg_temp.p('set_favorite','{"kind":"project","id":"a9301001-0000-4000-8000-000000000001","favorite":true}')->>'favorite'='true','project favorite created');
select pg_temp.p('set_favorite','{"kind":"project","id":"a9301001-0000-4000-8000-000000000001","favorite":true}');
select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000001","favorite":true}');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'favorites')=2,'favorite repeats are idempotent');
select pg_temp.p_assert((pg_temp.p('load')->'favorites')@>'[{"kind":"task","id":"e9300000-0000-4000-8000-000000000001","project_id":"a9301001-0000-4000-8000-000000000001"}]','favorite carries only permitted identity');
select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000001","favorite":false}');
select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000001","favorite":false}');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'favorites')=1,'repeated unset leaves other favorite');
select pg_temp.p_error($q$select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000001","favorite":true,"owner_id":"f9300000-0000-4000-8000-000000000002"}')$q$,'22023','cannot impersonate preference owner');
select pg_temp.p_error($q$select pg_temp.p('set_favorite','{"kind":"file","id":"a9301001-0000-4000-8000-000000000001","favorite":true}')$q$,'22023','unknown favorite resource rejected');
select pg_temp.p_error($q$select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000099","favorite":true}')$q$,'PT404','missing task unavailable');
select pg_temp.p_assert((select v from prod_values where k='fixture_task_before')=to_jsonb((select t from public.tr8_workspace_tasks t where id='e9300000-0000-4000-8000-000000000001')),'preference writes preserve task fields and versions');

insert into prod_values values('view',pg_temp.p('create_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000001','name',' Mi tablero ','context','project','project_id','a9301001-0000-4000-8000-000000000001','config',pg_temp.cfg())));
select pg_temp.p_assert((select v->>'name'='Mi tablero' and v->>'version'='1' and not(v?'owner_id') from prod_values where k='view'),'saved view trimmed and server managed');
select pg_temp.p_assert(pg_temp.p('create_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000001','name','Mi tablero','context','project','project_id','a9301001-0000-4000-8000-000000000001','config',pg_temp.cfg()))=(select v from prod_values where k='view'),'exact view create retry idempotent');
select pg_temp.p_error($q$select pg_temp.p('create_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000001','name','Different','context','project','project_id','a9301001-0000-4000-8000-000000000001','config',pg_temp.cfg()))$q$,'PT409','create request cannot be reused for different view');
select pg_temp.p_assert(pg_temp.p('update_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000001','version',1,'name','Renamed','config',pg_temp.cfg()))->>'version'='2','saved view updates CAS');
select pg_temp.p_error($q$select pg_temp.p('update_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000001','version',1,'name','Stale','config',pg_temp.cfg()))$q$,'PT409','stale view update denied');
select pg_temp.p_error($q$select pg_temp.p('delete_view','{"id":"c9300000-0000-4000-8000-000000000001","version":1}')$q$,'PT409','stale view deletion denied');
select pg_temp.p_error($q$select pg_temp.p('update_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000001','version',2,'name','Bad','config',pg_temp.cfg())||'{"context":"tasks"}')$q$,'22023','cannot move a saved view between contexts');
do $$declare bad jsonb; idx integer:=0;begin
  for bad in select value from jsonb_array_elements(jsonb_build_array(
    pg_temp.cfg()||'{"sql":"select secret"}',pg_temp.cfg()||'{"schemaVersion":2}',pg_temp.cfg()||'{"statuses":["done","done"]}',
    pg_temp.cfg()||'{"view":"timeline"}',pg_temp.cfg()||'{"projectIds":["not-a-uuid"]}',pg_temp.cfg()||'{"assigneeIds":["someone"]}',
    pg_temp.cfg()||'{"columns":["title"]}',pg_temp.cfg()||'{"favoritesOnly":"false"}',pg_temp.cfg()||'{"due":null}',pg_temp.cfg()||'{"query":false}',pg_temp.cfg()-'sort'
  )) loop
    idx:=idx+1;
    perform pg_temp.p_error(format('select pg_temp.p(''update_view'',jsonb_build_object(''id'',''c9300000-0000-4000-8000-000000000001'',''version'',2,''name'',''Bad'',''config'',%L::jsonb))',bad::text),'22023','malformed closed DTO '||idx);
  end loop;
end;$$;
select pg_temp.p_assert(pg_temp.p('load')->'views'->0->>'version'='2','failed views do not change persisted version');

select pg_temp.p_actor('f9300000-0000-4000-8000-000000000002');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'favorites')=0 and jsonb_array_length(pg_temp.p('load')->'views')=0,'other member has separate personal preferences');
select pg_temp.p_assert(pg_temp.p('set_favorite','{"kind":"project","id":"a9301001-0000-4000-8000-000000000001","favorite":true}')->>'favorite'='true','read-only member can favorite readable project');
select pg_temp.p_assert(pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000001","favorite":true}')->>'favorite'='true','read-only member can favorite readable task');
select pg_temp.p_error($q$select pg_temp.p('set_favorite','{"kind":"project","id":"a9301002-0000-4000-8000-000000000002","favorite":true}')$q$,'PT404','membership does not expose another private project');
select pg_temp.p_error($q$select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000003","favorite":true}')$q$,'PT404','task in inaccessible project cannot be starred');
select pg_temp.p_error($q$select pg_temp.p('delete_view','{"id":"c9300000-0000-4000-8000-000000000001","version":2}')$q$,'PT404','cannot delete another member view');
select pg_temp.p_error($q$select pg_temp.p('create_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000001','name','Hijack','context','tasks','project_id',null,'config',pg_temp.cfg()))$q$,'PT409','cannot overwrite another owner creation identifier');
select pg_temp.p_assert(pg_temp.p('create_view',jsonb_build_object('id','c9300000-0000-4000-8000-000000000002','name','Read-only view','context','project','project_id','a9301001-0000-4000-8000-000000000001','config',pg_temp.cfg()))->>'version'='1','reader can save own presentation without content write permission');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks','{"project_id":"a9301001-0000-4000-8000-000000000001","request_id":"09300000-0000-4000-8000-000000000001","items":[{"id":"e9300000-0000-4000-8000-000000000001","version":1,"position":2000},{"id":"e9300000-0000-4000-8000-000000000002","version":1,"position":1000}]}')$q$,'PT404','presentation access does not grant reorder');
reset role;
delete from tr8_private.role_permissions where workspace_id='d9300000-0000-4000-8000-000000000001' and permission='task.read' and role_id=(select id from tr8_private.workspace_roles where workspace_id='d9300000-0000-4000-8000-000000000001' and template_key='read');
set local role authenticated;
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'favorites')=1 and pg_temp.p('load')->'favorites'->0->>'kind'='project','task.read revocation hides task favorite but keeps readable project');
select pg_temp.p_error($q$select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000001","favorite":false}')$q$,'PT404','favorite mutation reauthorizes task read');
reset role;
delete from tr8_private.project_access where workspace_id='d9300000-0000-4000-8000-000000000001' and member_id='b9300000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.p_assert(pg_temp.p('load')='{"favorites":[],"views":[]}'::jsonb,'revoked project access hides prior favorites and scoped views');
select pg_temp.p_actor('f9300000-0000-4000-8000-000000000003');
select public.tr8_v2_get_context();
select pg_temp.p_error($q$select pg_temp.p('load')$q$,'PT404','different account cannot enumerate workspace preferences');
select pg_temp.p_actor('f9300000-0000-4000-8000-000000000001');

insert into prod_values values('order','[{"id":"e9300000-0000-4000-8000-000000000001","version":1,"position":2000},{"id":"e9300000-0000-4000-8000-000000000002","version":1,"position":1000}]');
insert into prod_values values('other_task',to_jsonb((select t from public.tr8_workspace_tasks t where id='e9300000-0000-4000-8000-000000000003')));
insert into prod_values values('reorder',pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000001','items',pg_temp.order_items())));
select pg_temp.p_assert((select v->0->>'id'='e9300000-0000-4000-8000-000000000002' and jsonb_array_length(v)=2 from prod_values where k='reorder'),'atomic order returns complete current list sorted by new position');
select pg_temp.p_assert((select version=2 and position=2000 from public.tr8_workspace_tasks where id='e9300000-0000-4000-8000-000000000001'),'order uses normal task versioning');
select pg_temp.p_assert(pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000001','items',pg_temp.order_items()))=(select v from prod_values where k='reorder'),'exact request replay does not rewrite tasks');
select pg_temp.p_assert((select v from prod_values where k='other_task')=to_jsonb((select t from public.tr8_workspace_tasks t where id='e9300000-0000-4000-8000-000000000003')),'reorder preserves unrelated tasks');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000002','items',pg_temp.order_items()))$q$,'PT409','new stale reorder fails CAS');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000001','items',jsonb_set(pg_temp.order_items(),'{0,position}','3000')))$q$,'PT409','request identifier does not accept different order');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000003','items',jsonb_build_array(pg_temp.order_items()->0)))$q$,'PT409','partial project order rejected');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000003','items',jsonb_build_array(pg_temp.order_items()->0,pg_temp.order_items()->0)))$q$,'22023','duplicate task order rejected');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000003','items',jsonb_set(pg_temp.order_items(),'{0,position}','1.5')))$q$,'22023','fractional order rejected');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000003','items',jsonb_set(pg_temp.order_items(),'{0,id}','"e9300000-0000-4000-8000-000000000003"')))$q$,'PT409','order cannot cross projects');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000003','items',jsonb_set(pg_temp.order_items(),'{0,position}','9007199254740992')))$q$,'22023','unsafe JavaScript order rejected');
select pg_temp.p_assert((select version=2 from public.tr8_workspace_tasks where id='e9300000-0000-4000-8000-000000000001'),'failed complete orders leave every row unchanged');
select public.tr8_v2_update_project('d9300000-0000-4000-8000-000000000001','a9301001-0000-4000-8000-000000000001',1,'{"archived_at":"2026-10-27T00:00:00Z"}');
select pg_temp.p_assert(pg_temp.p('set_favorite','{"kind":"project","id":"a9301001-0000-4000-8000-000000000001","favorite":true}')->>'favorite'='true','archived but readable project can remain favorite');
select pg_temp.p_error($q$select pg_temp.p('reorder_tasks',jsonb_build_object('project_id','a9301001-0000-4000-8000-000000000001','request_id','09300000-0000-4000-8000-000000000004','items',pg_temp.order_items()))$q$,'55000','archived project order is read only, including request replay');
select public.tr8_v2_update_project('d9300000-0000-4000-8000-000000000001','a9301001-0000-4000-8000-000000000001',2,'{"archived_at":null}');

select pg_temp.p('set_favorite','{"kind":"task","id":"e9300000-0000-4000-8000-000000000002","favorite":true}');
select public.tr8_v2_delete_task('d9300000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000002',2);
select pg_temp.p_assert(not((pg_temp.p('load')->'favorites')@>'[{"id":"e9300000-0000-4000-8000-000000000002"}]'),'deleting target removes favorite without orphan');
select pg_temp.p_assert(pg_temp.p('delete_view','{"id":"c9300000-0000-4000-8000-000000000001","version":2}')='{"id":"c9300000-0000-4000-8000-000000000001","deleted":true}'::jsonb,'versioned own view deletion confirmed');
select pg_temp.p_error($q$select pg_temp.p('delete_view','{"id":"c9300000-0000-4000-8000-000000000001","version":2}')$q$,'PT404','deleted saved view stays unavailable');
select public.tr8_v2_delete_project('a9301001-0000-4000-8000-000000000001',3,'Synthetic project A');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'favorites')=0,'deleting project cleans favorite metadata');
reset role;
select pg_temp.p_assert((select count(*)=0 from tr8_private.productivity_views where project_id='a9301001-0000-4000-8000-000000000001'),'project deletion cleans views of every member');
select pg_temp.p_assert((select count(*)=0 from tr8_private.productivity_reorders where project_id='a9301001-0000-4000-8000-000000000001'),'project deletion cleans only its request receipts');
delete from auth.sessions where id='f9300000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.p_error($q$select pg_temp.p('load')$q$,'42501','terminated session cannot load personal metadata');
select pg_temp.p_error($q$select pg_temp.p('set_favorite','{"kind":"project","id":"a9301002-0000-4000-8000-000000000002","favorite":true}')$q$,'42501','terminated session cannot write personal metadata');
reset role;
set local role anon;
select pg_temp.p_actor(null);
select pg_temp.p_error($q$select pg_temp.p('load')$q$,'42501','anonymous access denied at public grant');
reset role;
select pg_temp.p_assert((select b.hash=md5(coalesce((jsonb_agg(to_jsonb(p) order by p.id) filter(where p.id is not null))::text,'')) from prod_existing b left join public.tr8_workspace_projects p on p.id=any(b.ids) where b.kind='projects' group by b.hash),'pre-existing projects preserved');
select pg_temp.p_assert((select b.hash=md5(coalesce((jsonb_agg(to_jsonb(t) order by t.id) filter(where t.id is not null))::text,'')) from prod_existing b left join public.tr8_workspace_tasks t on t.id=any(b.ids) where b.kind='tasks' group by b.hash),'pre-existing tasks preserved');
select pg_temp.p_assert((select b.hash=md5(coalesce((jsonb_agg(to_jsonb(f) order by f.owner_id) filter(where f.owner_id is not null))::text,'')) from prod_existing b left join tr8_private.account_finances f on f.owner_id=any(b.ids) where b.kind='finance' group by b.hash),'pre-existing finance preserved');
select jsonb_build_object('checks',current_setting('tr8.productivity_checks')::int,'result','passed') as productivity_test_result;
rollback;
