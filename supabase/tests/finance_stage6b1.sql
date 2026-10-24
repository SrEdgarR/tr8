-- Disposable TEST only. Synthetic fixtures and all changes roll back. No HTTP,
-- real credentials, financial plaintext, project/task writes or sequence rewinds.
begin;
select set_config('tr8.finance_assertions','0',true);
create temporary table finance_before on commit drop as
select 'projects'::text kind,md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) hash from public.tr8_workspace_projects t
union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t;
create function pg_temp.f_assert(ok boolean,label text) returns void language plpgsql set search_path='' as $$ begin
  if ok is distinct from true then raise exception 'Finance assertion failed: %',label; end if;
  perform set_config('tr8.finance_assertions',(current_setting('tr8.finance_assertions')::integer+1)::text,true);
end; $$;
create function pg_temp.f_error(query text,expected text[],label text) returns void language plpgsql set search_path='' as $$ begin
  begin execute query; exception when others then
    if sqlstate=any(expected) then perform pg_temp.f_assert(true,label); return; end if;
    raise exception 'Finance assertion failed: % expected %, got %',label,expected,sqlstate;
  end;
  raise exception 'Finance assertion failed: % unexpectedly succeeded',label;
end; $$;
create function pg_temp.f_bytes(n integer,seed integer) returns text language sql immutable set search_path='' as $$
  select rtrim(translate(replace(encode(decode(repeat(lpad(to_hex(seed),2,'0'),n),'hex'),'base64'),E'\n',''),'+/','-_'),'=');
$$;
create function pg_temp.f_envelope(owner_id text,seed integer default 1) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('formatVersion',1,'suiteId','pulso-v1-aes256gcm-hkdfsha256-argon2id13','vaultId',pg_temp.f_bytes(16,seed),'ownerId',owner_id,
    'keyEpoch','1','credentialEpoch','1','revision','1','operationId',pg_temp.f_bytes(16,seed+1),'payloadSchemaVersion',1,
    'passwordWrap',jsonb_build_object('wrapVersion',1,'slotEpoch','1','kdfId','argon2id','argonVersion',19,'profileId','argon2id-64m-t3-p1-v1','memoryKiB',65536,'passes',3,'parallelism',1,'outputBytes',32,'salt',pg_temp.f_bytes(16,4),'nonce',pg_temp.f_bytes(12,5),'wrappedKey',pg_temp.f_bytes(48,6)),
    'recoveryWrap',jsonb_build_object('wrapVersion',1,'slotEpoch','1','schemeId','HKDF-SHA-256','salt',pg_temp.f_bytes(32,7),'nonce',pg_temp.f_bytes(12,8),'wrappedKey',pg_temp.f_bytes(48,9)),
    'payload',jsonb_build_object('keySalt',pg_temp.f_bytes(32,10),'nonce',pg_temp.f_bytes(12,11),'ciphertext',pg_temp.f_bytes(17,12)));
$$;
create function pg_temp.f_put(e jsonb,expected text default '0') returns text language sql immutable set search_path='' as $$
  select jsonb_build_object('expectedRevision',expected,'operationId',e->>'operationId','envelope',e)::text;
$$;
create function pg_temp.f_call(action text,body text default null,expected bigint default 1,vault text default null,operation text default null,target uuid default null)
returns jsonb language sql volatile set search_path='' as $$
  select public.tr8_server_finance(action,'f6b10000-0000-4000-8000-000000000001','f6b11000-0000-4000-8000-000000000001',
    floor(extract(epoch from clock_timestamp()+interval '1 hour'))::bigint,
    (select floor(extract(epoch from updated_at))::bigint from auth.mfa_amr_claims where session_id='f6b11000-0000-4000-8000-000000000001' and authentication_method='password'),
    case when body is null then null else encode(convert_to(body,'UTF8'),'base64') end,expected,vault,operation,target);
$$;

do $$ declare t text; f record; begin
  perform pg_temp.f_assert((select not synthetic_enabled and restore_quarantined and synthetic_only from tr8_finance.config where singleton),'migration starts closed');
  perform pg_temp.f_assert(not exists(select 1 from tr8_finance.synthetic_allowlist),'migration grants no actor');
  foreach t in array array['config','synthetic_allowlist','actors','vaults','receipts','retired','revoked_sessions','lifecycle_receipts'] loop
    perform pg_temp.f_assert((select relrowsecurity from pg_class where oid=('tr8_finance.'||t)::regclass),'RLS enabled: '||t);
    perform pg_temp.f_assert(not has_table_privilege('anon','tr8_finance.'||t,'SELECT,INSERT,UPDATE,DELETE'),'anon no DML: '||t);
    perform pg_temp.f_assert(not has_table_privilege('authenticated','tr8_finance.'||t,'SELECT,INSERT,UPDATE,DELETE'),'client no DML: '||t);
    perform pg_temp.f_assert(not has_table_privilege('service_role','tr8_finance.'||t,'SELECT,INSERT,UPDATE,DELETE'),'service no direct DML: '||t);
  end loop;
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tr8_finance' loop
    perform pg_temp.f_assert(not has_function_privilege('anon',f.signature,'EXECUTE'),'anon no helper: '||f.proname);
    perform pg_temp.f_assert(not has_function_privilege('authenticated',f.signature,'EXECUTE'),'client no helper: '||f.proname);
    if f.proname<>'server' then perform pg_temp.f_assert(not has_function_privilege('service_role',f.signature,'EXECUTE'),'service helper hidden: '||f.proname); end if;
  end loop;
  perform pg_temp.f_assert(not has_function_privilege('authenticated','public.tr8_server_finance(text,uuid,uuid,bigint,bigint,text,bigint,text,text,uuid)','EXECUTE'),'client RPC denied');
  perform pg_temp.f_assert(has_function_privilege('service_role','public.tr8_server_finance(text,uuid,uuid,bigint,bigint,text,bigint,text,text,uuid)','EXECUTE'),'backend RPC allowed');
  perform pg_temp.f_assert((select not prosecdef from pg_proc where oid='public.tr8_server_finance(text,uuid,uuid,bigint,bigint,text,bigint,text,text,uuid)'::regprocedure),'public wrapper invoker');
end; $$;

insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous)
select ('f6b10000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','tr8-finance-synthetic-'||n||'@example.test',clock_timestamp(),clock_timestamp(),clock_timestamp(),false from generate_series(1,3)n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f6b10000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'Finance fixture '||n from generate_series(1,3)n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
select ('f6b11000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('f6b10000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour' from generate_series(1,3)n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after) values('f6b11000-0000-4000-8000-000000000004','f6b10000-0000-4000-8000-000000000001',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at)
select gen_random_uuid(),id,'password',clock_timestamp(),clock_timestamp() from auth.sessions where id::text like 'f6b11000-%';

select pg_temp.f_error($q$select pg_temp.f_call('read')$q$,array['PT403'],'closed gate rejects even synthetic actor');
update tr8_finance.config set synthetic_enabled=true,restore_quarantined=false;
select pg_temp.f_error($q$select pg_temp.f_call('read')$q$,array['PT403'],'enabled gate without allowlist denies');
insert into tr8_finance.synthetic_allowlist(user_id) values('f6b10000-0000-4000-8000-000000000001'),('f6b10000-0000-4000-8000-000000000002');

do $$ declare v_owner text:='f6b10000-0000-4000-8000-000000000001'; e jsonb; next_e jsonb; body text; result jsonb; saved jsonb; key text; operation text;
begin
  e:=pg_temp.f_envelope(v_owner); body:=pg_temp.f_put(e);
  perform pg_temp.f_assert(tr8_finance.valid_envelope(e),'opaque fixture accepted');
  perform pg_temp.f_assert(not tr8_finance.valid_envelope(jsonb_set(e,'{suiteId}','null')),'null suite rejected');
  perform pg_temp.f_assert(not tr8_finance.valid_envelope(jsonb_set(e,'{passwordWrap,kdfId}','null')),'null KDF rejected');
  perform pg_temp.f_assert(not tr8_finance.valid_envelope(jsonb_set(e,'{payload,nonce}','1234567890123456')),'numeric nonce rejected');
  perform pg_temp.f_assert(not tr8_finance.valid_envelope(e||'{"extra":true}'),'closed envelope');
  perform pg_temp.f_assert(pg_temp.f_call('read')->'envelope'='null'::jsonb,'initial empty vault');
  result:=pg_temp.f_call('put',body);
  perform pg_temp.f_assert(result=jsonb_build_object('revision','1','operationId',e->>'operationId'),'first commit acknowledged');
  perform pg_temp.f_assert(pg_temp.f_call('put',body)=result,'exact retry returns prior receipt');
  perform pg_temp.f_assert((select count(*)=1 from tr8_finance.receipts where owner_id='f6b10000-0000-4000-8000-000000000001'),'retry creates one receipt');
  perform pg_temp.f_assert(pg_temp.f_call('receipt',null,1,e->>'vaultId',e->>'operationId')=result,'technical receipt can confirm lost ACK');
  perform pg_temp.f_error(format('select pg_temp.f_call(''put'',%L)',body||E'\n'),array['PT409'],'same ID different bytes conflicts');
  perform pg_temp.f_error(format('select pg_temp.f_call(''put'',%L)',replace(body,'"expectedRevision": "0"','"expectedRevision": "0", "expectedRevision": "0"')),array['PT400'],'duplicate JSON keys rejected inside backend');
  perform pg_temp.f_error(format('select pg_temp.f_call(''put'',%L)',pg_temp.f_put(jsonb_set(e,'{ownerId}','"foreign"'))),array['PT403'],'foreign envelope denied');
  next_e:=jsonb_set(jsonb_set(jsonb_set(e,'{revision}','"2"'),'{operationId}',to_jsonb(pg_temp.f_bytes(16,30))),'{payload}',jsonb_build_object('keySalt',pg_temp.f_bytes(32,31),'nonce',pg_temp.f_bytes(12,32),'ciphertext',pg_temp.f_bytes(17,33)));
  perform pg_temp.f_error(format('select pg_temp.f_call(''put'',%L)',pg_temp.f_put(next_e)),array['PT409'],'CAS stale revision');
  perform pg_temp.f_assert(pg_temp.f_call('put',pg_temp.f_put(next_e,'1'))->>'revision'='2','next CAS commit');
  saved:=pg_temp.f_call('read')->'envelope';
  -- Force a receipt INSERT failure after the vault write, without test hooks in
  -- production SQL. The caught subtransaction must roll back both statements.
  execute 'alter table tr8_finance.receipts add constraint fixture_reject_receipt check(revision<3)';
  next_e:=jsonb_set(jsonb_set(jsonb_set(next_e,'{revision}','"3"'),'{operationId}',to_jsonb(pg_temp.f_bytes(16,40))),'{payload}',jsonb_build_object('keySalt',pg_temp.f_bytes(32,41),'nonce',pg_temp.f_bytes(12,42),'ciphertext',pg_temp.f_bytes(17,43)));
  perform pg_temp.f_error(format('select pg_temp.f_call(''put'',%L)',pg_temp.f_put(next_e,'2')),array['23514'],'receipt failure rolls back snapshot');
  perform pg_temp.f_assert(pg_temp.f_call('read')->'envelope'=saved,'failed receipt did not change snapshot');
  perform pg_temp.f_assert(not exists(select 1 from tr8_finance.receipts where operation_id=next_e->>'operationId'),'failed receipt absent');
  execute 'alter table tr8_finance.receipts drop constraint fixture_reject_receipt';
  perform pg_temp.f_assert(pg_temp.f_call('put',pg_temp.f_put(next_e,'2'))->>'revision'='3','same bytes can retry after rollback');
  operation:=pg_temp.f_bytes(16,70);
  result:=pg_temp.f_call('reset',null,1,e->>'vaultId',operation);
  perform pg_temp.f_assert(result->>'epoch'='2','reset increments epoch');
  perform pg_temp.f_assert(pg_temp.f_call('reset',null,1,e->>'vaultId',operation)=result,'reset normalized retry idempotent');
  perform pg_temp.f_error(format('select pg_temp.f_call(''put'',%L,2)',body),array['PT403'],'retired context rejected before old receipt');
  perform pg_temp.f_error(format('select pg_temp.f_call(''receipt'',null,2,%L,%L)',e->>'vaultId',e->>'operationId'),array['PT403'],'retired receipt cannot revive context');
  perform pg_temp.f_assert(pg_temp.f_call('read')->'envelope'='null'::jsonb,'reset removes active snapshot');
  perform pg_temp.f_assert(exists(select 1 from tr8_finance.revoked_sessions where session_id='f6b11000-0000-4000-8000-000000000004'),'reset revokes other financial session');
end; $$;

do $$ declare expired bigint:=floor(extract(epoch from clock_timestamp()-interval '10 minutes'))::bigint; exp bigint:=floor(extract(epoch from clock_timestamp()+interval '1 hour'))::bigint; e jsonb; body text; begin
  e:=pg_temp.f_envelope('f6b10000-0000-4000-8000-000000000001',80); body:=pg_temp.f_put(e);
  perform pg_temp.f_error(format('select public.tr8_server_finance(''put'',''f6b10000-0000-4000-8000-000000000001'',''f6b11000-0000-4000-8000-000000000001'',%s,null,%L,2)',exp,encode(convert_to(body,'UTF8'),'base64')),array['PT428'],'missing signed login proof denied');
  perform pg_temp.f_error(format('select public.tr8_server_finance(''put'',''f6b10000-0000-4000-8000-000000000001'',''f6b11000-0000-4000-8000-000000000001'',%s,%s,%L,2)',exp,expired,encode(convert_to(body,'UTF8'),'base64')),array['PT428'],'stale or mismatched AMR denied');
  perform pg_temp.f_error(format('select public.tr8_server_finance(''read'',''f6b10000-0000-4000-8000-000000000001'',''f6b11000-0000-4000-8000-000000000002'',%s)',exp),array['PT401'],'session owned by another user denied');
  update tr8_private.app_users set enabled=false where user_id='f6b10000-0000-4000-8000-000000000001';
  perform pg_temp.f_error($q$select pg_temp.f_call('read')$q$,array['PT403'],'application disabled identity denied');
  update tr8_private.app_users set enabled=true where user_id='f6b10000-0000-4000-8000-000000000001';
  update auth.users set banned_until=clock_timestamp()+interval '1 day' where id='f6b10000-0000-4000-8000-000000000001';
  perform pg_temp.f_error($q$select pg_temp.f_call('read')$q$,array['PT401'],'Auth banned identity denied');
  update auth.users set banned_until=null where id='f6b10000-0000-4000-8000-000000000001';
  delete from auth.sessions where id='f6b11000-0000-4000-8000-000000000001';
  perform pg_temp.f_error($q$select pg_temp.f_call('read')$q$,array['PT401'],'live Auth logout blocks a still signed token');
end; $$;

select pg_temp.f_assert((select hash from pg_temp.finance_before where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_projects t),'all projects preserved');
select pg_temp.f_assert((select hash from pg_temp.finance_before where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t),'all tasks preserved');
do $$ begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace::text); end; $$;
grant execute on function pg_temp.f_error(text,text[],text),pg_temp.f_assert(boolean,text) to anon,authenticated;
set local role anon;
select pg_temp.f_error($q$select public.tr8_server_finance('read',null::uuid,null::uuid,0)$q$,array['42501'],'actual anonymous role cannot invoke backend');
reset role;
set local role authenticated;
select pg_temp.f_error($q$select public.tr8_server_finance('read',null::uuid,null::uuid,0)$q$,array['42501'],'actual client role cannot invoke backend');
reset role;
select current_setting('tr8.finance_assertions')::integer finance_stage6b1_assertions;
rollback;
