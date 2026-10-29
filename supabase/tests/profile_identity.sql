-- TEST ONLY. Invoke in tr8-test, never production. No credentials or mail.
begin;
select set_config('tr8.profile_checks','0',true);
create temporary table profile_values(k text primary key,v jsonb) on commit drop;
create temporary table profile_before on commit drop as select
  (select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.user_id)::text,'')) from tr8_private.app_users x) app_users,
  (select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.id)::text,'')) from public.tr8_workspace_projects x) projects,
  (select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.id)::text,'')) from public.tr8_workspace_tasks x) tasks,
  (select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.owner_id)::text,'')) from tr8_private.account_finances x) finances,
  (select md5(coalesce(jsonb_agg(to_jsonb(x))::text,'')) from tr8_private.app_config x) config;
create function pg_temp.p_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Profile assertion: %',label;end if;
 perform set_config('tr8.profile_checks',(current_setting('tr8.profile_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.p_error(command text,expected text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=expected then perform pg_temp.p_assert(true,label);return;end if;
  raise exception 'Profile expected % got % (%) for %',expected,sqlstate,sqlerrm,label;
 end;raise exception 'Profile unexpectedly allowed: %',label;
end;$$;
create function pg_temp.p_actor(a uuid,s uuid default null) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else
  jsonb_strip_nulls(jsonb_build_object('sub',a,'role','authenticated','session_id',s))::text end,true);
end;$$;
create function pg_temp.p_value(name text) returns jsonb language sql as $$select v from profile_values where k=$1;$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on profile_values to authenticated;
grant select,insert on profile_values to anon;
grant execute on function pg_temp.p_assert(boolean,text),pg_temp.p_error(text,text,text),pg_temp.p_actor(uuid,uuid),pg_temp.p_value(text) to authenticated,anon;

select pg_temp.p_assert(not has_function_privilege('anon','public.tr8_v2_profile(text,timestamptz)','execute'),'anonymous profile endpoint denied');
select pg_temp.p_assert(not has_function_privilege('service_role','public.tr8_v2_profile(text,timestamptz)','execute'),'service role gets no profile endpoint');
select pg_temp.p_assert(has_function_privilege('authenticated','public.tr8_v2_profile(text,timestamptz)','execute'),'authenticated wrapper granted');
select pg_temp.p_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_profile(text,timestamptz)'::regprocedure),'public wrapper is invoker with empty path');
select pg_temp.p_assert(not has_table_privilege('authenticated','tr8_private.app_users','select,update'),'profile table remains private');
select pg_temp.p_assert(not exists(select 1 from auth.users where id::text like 'fb120000-%'),'fixture IDs unused');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('fb120000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','profile-identity-'||n||'@example.test',now(),'{}','{}',now(),now()
 from generate_series(1,4)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'fb120000-%';
insert into tr8_private.app_users(user_id,enabled,display_name)
 select id,n<>3,'Synthetic profile '||n from generate_series(1,3)n join auth.users on id=('fb120000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
set local role authenticated;
select pg_temp.p_actor('fb120000-0000-4000-8000-000000000001','fb120000-0000-4000-8000-000000000001');
insert into profile_values values('initial',public.tr8_v2_profile());
select pg_temp.p_assert(pg_temp.p_value('initial')->>'user_id'='fb120000-0000-4000-8000-000000000001','read bound to current actor');
select pg_temp.p_assert((select array_agg(k order by k)=array['display_name','updated_at','user_id'] from jsonb_object_keys(pg_temp.p_value('initial'))k),'minimal public output only');
insert into profile_values values('context',public.tr8_v2_get_context());
insert into profile_values values('pat',public.tr8_mcp_credentials('create',jsonb_build_object('workspace_id',pg_temp.p_value('context')->>'personal_workspace_id','name','Synthetic profile boundary','access','write','expires_in_days',7)));
select public.tr8_v2_create_project((pg_temp.p_value('context')->>'personal_workspace_id')::uuid,'ab120000-0000-4000-8000-000000000001','Synthetic profile project','','#5A67D8','active');
insert into profile_values values('saved',public.tr8_v2_profile('  Ángela de prueba  ',(pg_temp.p_value('initial')->>'updated_at')::timestamptz));
select pg_temp.p_assert(pg_temp.p_value('saved')->>'display_name'='Ángela de prueba','trimmed name saved');
select pg_temp.p_assert((pg_temp.p_value('saved')->>'updated_at')::timestamptz>(pg_temp.p_value('initial')->>'updated_at')::timestamptz,'profile revision advanced');
select pg_temp.p_assert(public.tr8_v2_profile('Ángela de prueba',(pg_temp.p_value('initial')->>'updated_at')::timestamptz)=pg_temp.p_value('saved'),'same-name retry with old revision does not write again');
select pg_temp.p_error($q$select public.tr8_v2_profile('Otra edición',(pg_temp.p_value('initial')->>'updated_at')::timestamptz)$q$,'PT409','stale different name conflicts');
select pg_temp.p_assert(public.tr8_v2_profile()=pg_temp.p_value('saved'),'conflict preserves saved profile');
select pg_temp.p_assert(public.tr8_v2_list_activity((pg_temp.p_value('context')->>'personal_workspace_id')::uuid)->'items'->0->>'actor_name'='Ángela de prueba','existing activity reads configured display name');
select pg_temp.p_error($q$select public.tr8_v2_profile('A name',null)$q$,'22023','name without expected revision rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile(null,now())$q$,'22023','revision without name rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile('',now())$q$,'22023','empty name rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile('   ',now())$q$,'22023','blank name rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile(repeat('x',121),now())$q$,'22023','long name rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile(E'Name\nNewline',now())$q$,'22023','line break rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile(E'Name\tTab',now())$q$,'22023','tab rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile('Name'||chr(127),now())$q$,'22023','DEL rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile('Name'||chr(128),now())$q$,'22023','C1 control rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile('Name','infinity')$q$,'22023','infinite revision rejected');
select pg_temp.p_error($q$select public.tr8_v2_profile('Name','2026-02-30')$q$,'22008','malformed timestamp rejected by typed argument');
select pg_temp.p_error($q$select display_name from tr8_private.app_users$q$,'42501','authenticated direct profile read denied');
select pg_temp.p_error($q$update tr8_private.app_users set display_name='Bypass' where user_id='fb120000-0000-4000-8000-000000000002'$q$,'42501','authenticated cannot update another profile');
select pg_temp.p_actor('fb120000-0000-4000-8000-000000000002','fb120000-0000-4000-8000-000000000002');
select pg_temp.p_assert(public.tr8_v2_profile()->>'display_name'='Synthetic profile 2','another actor reads only their own profile');
select pg_temp.p_actor('fb120000-0000-4000-8000-000000000003','fb120000-0000-4000-8000-000000000003');
select pg_temp.p_error($q$select public.tr8_v2_profile()$q$,'42501','disabled account denied');
select pg_temp.p_actor('fb120000-0000-4000-8000-000000000004','fb120000-0000-4000-8000-000000000004');
select pg_temp.p_error($q$select public.tr8_v2_profile()$q$,'42501','unprovisioned account denied');
select pg_temp.p_actor('fb120000-0000-4000-8000-000000000001',null);
select pg_temp.p_error($q$select public.tr8_v2_profile()$q$,'42501','MCP-like request without browser session denied');
select pg_temp.p_actor('fb120000-0000-4000-8000-000000000001','fb120000-0000-4000-8000-000000000002');
select pg_temp.p_error($q$select public.tr8_v2_profile()$q$,'42501','session belonging to another actor denied');
reset role;
set local role anon;
select pg_temp.p_actor(null,null);
insert into profile_values values('pat_context',public.tr8_mcp_dispatch(pg_temp.p_value('pat')->>'token','context'));
select pg_temp.p_assert(pg_temp.p_value('pat_context')#>>'{workspace,id}'=pg_temp.p_value('context')->>'personal_workspace_id','real delegated token still authenticates normal MCP operations');
insert into profile_values values('pat_profile',public.tr8_mcp_dispatch(pg_temp.p_value('pat')->>'token','profile','{}'));
select pg_temp.p_assert(pg_temp.p_value('pat_profile')#>>'{_tr8_mcp_error,code}'='22023','delegated token cannot expand to profile configuration');
select pg_temp.p_assert(auth.uid() is null and coalesce(current_setting('tr8.mcp_credential_id',true),'')='','MCP caller context restored');
reset role;
delete from auth.sessions where id='fb120000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.p_actor('fb120000-0000-4000-8000-000000000001','fb120000-0000-4000-8000-000000000001');
select pg_temp.p_error($q$select public.tr8_v2_profile()$q$,'42501','terminated session read denied');
select pg_temp.p_error($q$select public.tr8_v2_profile('Ángela de prueba',(pg_temp.p_value('initial')->>'updated_at')::timestamptz)$q$,'42501','terminated session replay denied');
reset role;
set local role anon;
select pg_temp.p_actor(null,null);
select pg_temp.p_error($q$select public.tr8_v2_profile()$q$,'42501','anonymous request denied');
reset role;
select pg_temp.p_assert((select enabled and display_name='Synthetic profile 2' from tr8_private.app_users where user_id='fb120000-0000-4000-8000-000000000002'),'other account untouched');
select pg_temp.p_assert((select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.user_id)::text,'')) from tr8_private.app_users x where x.user_id::text not like 'fb120000-%')=(select app_users from profile_before),'real app users unchanged');
select pg_temp.p_assert((select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.id)::text,'')) from public.tr8_workspace_projects x where x.owner_id::text not like 'fb120000-%')=(select projects from profile_before),'real projects unchanged');
select pg_temp.p_assert((select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.id)::text,'')) from public.tr8_workspace_tasks x where x.owner_id::text not like 'fb120000-%')=(select tasks from profile_before),'real tasks unchanged');
select pg_temp.p_assert((select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.owner_id)::text,'')) from tr8_private.account_finances x)=(select finances from profile_before),'finances unchanged');
select pg_temp.p_assert((select md5(coalesce(jsonb_agg(to_jsonb(x))::text,'')) from tr8_private.app_config x)=(select config from profile_before),'closed registrations and configuration unchanged');
select current_setting('tr8.profile_checks')::integer as profile_checks_passed;
rollback;
