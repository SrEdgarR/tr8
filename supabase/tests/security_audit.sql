-- Current-schema security regression suite. TEST only; all fixtures roll back.
begin;
select set_config('request.jwt.claim','',true);
select set_config('request.jwt.claims','{}',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('tr8.security_checks','0',true);
create temporary table audit_values(k text primary key,v jsonb) on commit drop;
create temporary table audit_before on commit drop as
select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) digest,array_agg(id) ids from public.tr8_workspace_projects p
union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
union all select 'finance',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create function pg_temp.sec_assert(ok boolean,label text) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'Security assertion failed: %',label; end if;
 perform set_config('tr8.security_checks',(current_setting('tr8.security_checks')::int+1)::text,true);
end;$$;
create function pg_temp.sec_actor(a uuid,s text) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim','',true);
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',s,
   'user_metadata',jsonb_build_object('role','Owner','tr8_mcp_credential_id','forged'))::text end,true);
end;$$;
create function pg_temp.sec_error(command text,expected text,label text) returns void language plpgsql as $$
begin
 begin execute command;
 exception when others then
  if sqlstate=expected then perform pg_temp.sec_assert(true,label); return; end if;
  raise exception 'Security assertion failed: %; expected %, got %',label,expected,sqlstate;
 end;
 raise exception 'Security assertion failed: %; unexpectedly allowed',label;
end;$$;
do $$begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on pg_temp.audit_values to anon,authenticated;
grant select on pg_temp.audit_before to authenticated;
grant execute on function pg_temp.sec_assert(boolean,text),pg_temp.sec_actor(uuid,text),pg_temp.sec_error(text,text,text) to anon,authenticated;
insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f9100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','security-audit-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,3)n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f9100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'Synthetic security '||n from generate_series(1,2)n;
insert into auth.sessions(id,user_id,created_at,updated_at)
select id,id,now(),now() from auth.users where id::text like 'f9100000-%';
set local role authenticated;
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001');
insert into audit_values values('context',public.tr8_v2_get_context());
insert into audit_values values('write',public.tr8_mcp_credentials('create',jsonb_build_object('workspace_id',(select v->>'personal_workspace_id' from audit_values where k='context'),'name','Synthetic audit write','access','write','expires_in_days',90)));
insert into audit_values values('read',public.tr8_mcp_credentials('create',jsonb_build_object('workspace_id',(select v->>'personal_workspace_id' from audit_values where k='context'),'name','Synthetic audit read','access','read','expires_in_days',7)));
insert into audit_values values('project',to_jsonb(public.tr8_v2_create_project((select (v->>'personal_workspace_id')::uuid from audit_values where k='context'),'f9101000-0000-4000-8000-000000000001','Synthetic security project','','#8B8CF8','active')));
insert into audit_values values('task',to_jsonb(public.tr8_v2_create_task((select (v->>'personal_workspace_id')::uuid from audit_values where k='context'),'f9102000-0000-4000-8000-000000000001','f9101000-0000-4000-8000-000000000001','Original safe title','','todo','none',null,null)));
reset role;
update tr8_private.app_config set external_invites_enabled=true where singleton;
set local role authenticated;
insert into audit_values values('team',public.tr8_v2_create_team('f9103000-0000-4000-8000-000000000001','Synthetic invitation security'));
insert into audit_values values('invitation',public.tr8_v2_create_invitation('f9103000-0000-4000-8000-000000000001','f9104000-0000-4000-8000-000000000001','security-audit-3@example.test'));
select pg_temp.sec_assert((select count(*)=1 from public.tr8_workspace_projects where id='f9101000-0000-4000-8000-000000000001'),'live session reads own data');
reset role;
set local role authenticated;
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001');
select pg_temp.sec_assert(public.tr8_account_finance()->>'version'='0','new account has no finance document');
insert into audit_values values('financial_snapshot','{"schemaVersion":1,"financialSpace":{"domainSchemaVersion":4,"currencyCatalogVersion":"currency-catalog-v1","currencyDefinitions":[{"code":"DOP","minorUnitDigits":2}],"accounts":[{"id":"f9105000-0000-4000-8000-000000000001","name":"Synthetic DOP account","currency":"DOP","type":"cash","openingBalanceMinor":12345,"openingDate":"2026-10-26"}],"operations":[],"plans":[]}}');
select pg_temp.sec_assert(public.tr8_account_finance((select v from audit_values where k='financial_snapshot'),'0','f9106000-0000-4000-8000-000000000001')->>'version'='1','live owner can persist finance snapshot');
select pg_temp.sec_assert(public.tr8_account_finance()->'snapshot'=(select v from audit_values where k='financial_snapshot'),'finance read returns exact own document');
select pg_temp.sec_assert(public.tr8_account_finance((select v from audit_values where k='financial_snapshot'),'0','f9106000-0000-4000-8000-000000000001')->>'version'='1','exact finance retry is idempotent');
select pg_temp.sec_error($q$select public.tr8_account_finance((select v from audit_values where k='financial_snapshot'),'0','f9106000-0000-4000-8000-000000000002')$q$,'PT409','stale finance version cannot overwrite data');
select pg_temp.sec_error($q$select public.tr8_account_finance((select jsonb_set(v,'{financialSpace,accounts}','[]') from audit_values where k='financial_snapshot'),'0','f9106000-0000-4000-8000-000000000001')$q$,'PT409','operation identity cannot be reused with changed finance');
select pg_temp.sec_error($q$select public.tr8_account_finance((select v||'{"owner_id":"f9100000-0000-4000-8000-000000000002"}'::jsonb from audit_values where k='financial_snapshot'),'1','f9106000-0000-4000-8000-000000000003')$q$,'PT400','snapshot cannot supply another owner');
select pg_temp.sec_error('select * from tr8_private.account_finances','42501','authenticated users cannot select private financial table');
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000002','f9100000-0000-4000-8000-000000000002');
select pg_temp.sec_assert(public.tr8_account_finance()->'snapshot'='null'::jsonb,'another account cannot read the first account finances');
set local role anon;
select pg_temp.sec_actor(null,null);
select pg_temp.sec_error('select public.tr8_account_finance()','42501','anonymous callers cannot read financial RPC');
reset role;
insert into audit_values select 'quota',to_jsonb(day_count) from tr8_private.mcp_credentials where id=(select (v->>'id')::uuid from audit_values where k='read');
set local role anon;
select pg_temp.sec_actor(null,null);
do $$declare result jsonb;begin
 for i in 1..3 loop
  result:=public.tr8_mcp_dispatch((select v->>'token' from audit_values where k='read'),'calendar','{"date_from":"2026-10-26","date_to":"2026-10-26","time_zone":"invalid"}');
  perform pg_temp.sec_assert(result#>>'{_tr8_mcp_error,code}' is not null,'invalid command returns closed envelope');
  perform pg_temp.sec_assert((select count(*) from jsonb_object_keys(result))=1 and (select count(*) from jsonb_object_keys(result->'_tr8_mcp_error'))=1,'error has no diagnostics or payload');
 end loop;
end;$$;
reset role;
select pg_temp.sec_assert((select day_count-(select v::text::int from audit_values where k='quota')=3 from tr8_private.mcp_credentials where id=(select (v->>'id')::uuid from audit_values where k='read')),'failed calls charge durable quota');
insert into audit_values select 'activity_before',to_jsonb(count(*)) from tr8_private.mcp_activity where credential_id=(select (v->>'id')::uuid from audit_values where k='write');
set local role anon;
insert into audit_values values('partial',public.tr8_mcp_dispatch((select v->>'token' from audit_values where k='write'),'update_task','{"id":"f9102000-0000-4000-8000-000000000001","version":1,"patch":{"title":"Must roll back","assignee_member_id":"f9109999-0000-4000-8000-000000000001"}}'));
select pg_temp.sec_assert((select v?'_tr8_mcp_error' from audit_values where k='partial'),'second operation failure is reported');
reset role;
select pg_temp.sec_assert((select title='Original safe title' and version=1 from public.tr8_workspace_tasks where id='f9102000-0000-4000-8000-000000000001'),'failed combined write rolls back first mutation');
select pg_temp.sec_assert((select count(*)=(select v::text::int from audit_values where k='activity_before') from tr8_private.mcp_activity where credential_id=(select (v->>'id')::uuid from audit_values where k='write')),'failed write leaves no successful audit event');
delete from auth.sessions where id='f9100000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001');
select pg_temp.sec_assert((select count(*)=0 from public.tr8_workspace_projects where id='f9101000-0000-4000-8000-000000000001'),'revoked session cannot read RLS project');
select pg_temp.sec_assert((select count(*)=0 from public.tr8_workspace_tasks where id='f9102000-0000-4000-8000-000000000001'),'revoked session cannot read RLS task');
select pg_temp.sec_error('select public.tr8_v2_get_context()','42501','revoked session cannot get application context');
select pg_temp.sec_error('select public.tr8_account_finance()','42501','revoked session cannot read finance');
select pg_temp.sec_error($q$select public.tr8_account_finance((select v from audit_values where k='financial_snapshot'),'1','f9106000-0000-4000-8000-000000000004')$q$,'42501','revoked session cannot save finance');
select pg_temp.sec_error($q$select public.tr8_mcp_credentials('list')$q$,'42501','revoked session cannot list credentials');
select pg_temp.sec_error($q$select public.tr8_mcp_credentials('create',jsonb_build_object('workspace_id',(select v->>'personal_workspace_id' from audit_values where k='context'),'name','Forbidden','access','write','expires_in_days',90))$q$,'42501','revoked session cannot mint durable key');
select pg_temp.sec_error($q$select public.tr8_mcp_credentials('revoke',jsonb_build_object('id',(select v->>'id' from audit_values where k='write')))$q$,'42501','revoked session cannot revoke connections');
select pg_temp.sec_error($q$select public.tr8_v2_update_task((select (v->>'personal_workspace_id')::uuid from audit_values where k='context'),'f9102000-0000-4000-8000-000000000001',1,'{"title":"Forbidden"}')$q$,'42501','revoked session cannot mutate tasks');
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000002');
select pg_temp.sec_error('select public.tr8_v2_get_context()','42501','cannot adopt session belonging to another user');
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000001','bad-session');
select pg_temp.sec_error('select public.tr8_v2_get_context()','42501','malformed session is denied');
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000001',null);
select pg_temp.sec_error('select public.tr8_v2_get_context()','42501','missing session and forged metadata are denied');
set local role anon;
select pg_temp.sec_actor(null,null);
insert into audit_values values('delegated',public.tr8_mcp_dispatch((select v->>'token' from audit_values where k='write'),'context'));
select pg_temp.sec_assert((select v#>>'{workspace,id}'=(select v->>'personal_workspace_id' from audit_values where k='context') from audit_values where k='delegated'),'independent PAT still works after browser logout');
select pg_temp.sec_assert(coalesce(current_setting('tr8.mcp_credential_id',true),'')='' and coalesce(current_setting('tr8.mcp_token_hash',true),'')='','delegate markers restored after success');
select pg_temp.sec_assert(auth.uid() is null,'caller identity restored after success');
select set_config('request.jwt.claim','{"sub":"f9100000-0000-4000-8000-000000000002","session_id":"f9100000-0000-4000-8000-000000000002"}',true);
insert into audit_values values('legacy',public.tr8_mcp_dispatch((select v->>'token' from audit_values where k='write'),'context'));
select pg_temp.sec_assert((select v#>>'{workspace,id}'=(select v->>'personal_workspace_id' from audit_values where k='context') from audit_values where k='legacy'),'delegate overrides legacy singular claims during command');
select pg_temp.sec_assert(auth.jwt()->>'session_id'='f9100000-0000-4000-8000-000000000002','legacy singular claims restored');
select set_config('request.jwt.claim','',true);
insert into audit_values values('failure',public.tr8_mcp_dispatch((select v->>'token' from audit_values where k='write'),'get_task','{"id":"f9109999-0000-4000-8000-000000000001"}'));
select pg_temp.sec_assert((select v#>>'{_tr8_mcp_error,code}'='PT404' from audit_values where k='failure'),'missing task gives generic error');
select pg_temp.sec_assert(auth.uid() is null and coalesce(current_setting('tr8.mcp_credential_id',true),'')='' and coalesce(current_setting('tr8.mcp_token_hash',true),'')='','identity and markers restored after failed dispatch');
reset role;
insert into auth.sessions(id,user_id,created_at,not_after) values('f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001',now(),now()-interval '1 minute');
set local role authenticated;
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001');
select pg_temp.sec_error('select public.tr8_v2_get_context()','42501','expired session denied');
reset role;
delete from auth.sessions where id='f9100000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.sec_actor('f9100000-0000-4000-8000-000000000003','f9100000-0000-4000-8000-000000000003');
select pg_temp.sec_error($q$select public.tr8_v2_accept_invitation((select v->>'token' from audit_values where k='invitation'))$q$,'42501','revoked invitee session cannot accept a real invitation');
reset role;
select pg_temp.sec_assert(not exists(select 1 from tr8_private.app_users where user_id='f9100000-0000-4000-8000-000000000003'),'denied invitation cannot enable the new user');
insert into auth.sessions(id,user_id,created_at) values('f9100000-0000-4000-8000-000000000003','f9100000-0000-4000-8000-000000000003',now());
set local role authenticated;
select pg_temp.sec_assert(public.tr8_v2_accept_invitation((select v->>'token' from audit_values where k='invitation'))->>'status'='accepted','live invitee can accept invitation and bootstrap account');
reset role;
update tr8_private.app_config set external_invites_enabled=false where singleton;
select pg_temp.sec_assert(not has_function_privilege('anon','tr8_private.v7_actor_session_live()','EXECUTE') and not has_function_privilege('authenticated','tr8_private.v7_actor_session_live()','EXECUTE'),'session helper not directly executable');
select pg_temp.sec_assert(not has_function_privilege('anon','tr8_private.v7_require_browser_session()','EXECUTE') and not has_function_privilege('authenticated','tr8_private.v7_require_browser_session()','EXECUTE'),'interactive guard not directly executable');
select pg_temp.sec_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external invitations remain disabled');
select pg_temp.sec_assert((select digest=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where id=any(b.ids)) from audit_before b where kind='projects'),'pre-existing projects preserved');
select pg_temp.sec_assert((select digest=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where id=any(b.ids)) from audit_before b where kind='tasks'),'pre-existing tasks preserved');
select pg_temp.sec_assert((select digest=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where owner_id=any(b.ids)) from audit_before b where kind='finance'),'pre-existing finance documents preserved');
select jsonb_build_object('result','passed','checks',current_setting('tr8.security_checks')::int) as security_audit;
rollback;
