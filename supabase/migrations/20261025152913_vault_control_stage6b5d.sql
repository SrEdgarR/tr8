-- TEST ONLY. Opaque-head/identity coordinator. Default closed; no project/task DML.
create schema tr8_vault_control;
revoke all on schema tr8_vault_control from public,anon,authenticated,service_role;
create table tr8_vault_control.config(singleton boolean primary key default true check(singleton),enabled boolean not null default false,quarantined boolean not null default true,authority_id uuid,case_id text);
insert into tr8_vault_control.config(singleton) values(true);
create table tr8_vault_control.projection(owner_id uuid primary key,state jsonb not null,envelope jsonb,check(state->>'ownerId'=owner_id::text));
create table tr8_vault_control.operations(owner_id uuid not null,operation_id text not null,intent jsonb not null,primary key(owner_id,operation_id));

create function tr8_vault_control.stable(v jsonb) returns text language plpgsql immutable set search_path='' as $$
declare result text; begin
  if jsonb_typeof(v)='object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||tr8_vault_control.stable(value),',' order by key collate "C"),'')||'}' into result from jsonb_each(v); return result;
  elsif jsonb_typeof(v)='array' then select '['||coalesce(string_agg(tr8_vault_control.stable(value),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality as e(value,ord); return result;
  else return v::text; end if;
end; $$;
create function tr8_vault_control.live(a uuid,s uuid,exp bigint,authority uuid,case_name text,allow_disabled boolean default false)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare cfg tr8_vault_control.config; u record; login record; begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='READ_COMMITTED_REQUIRED'; end if;
  select * into cfg from tr8_vault_control.config where singleton for update;
  if not cfg.enabled or cfg.authority_id is distinct from authority or cfg.case_id is distinct from case_name or authority::text is distinct from 'c59d8b98-4cbf-4f74-a968-0c591a3d794a'
    or case_name not in ('heads','revoke','logout','disable','delete','reset','resume','recovery') or a::text is distinct from '37848d70-989a-4f69-b124-0c959d8b49a6' then raise exception using errcode='PT403',message='CONTROL_DISABLED'; end if;
  select email,email_confirmed_at,deleted_at,is_anonymous,banned_until into u from auth.users where id=a for share;
  if not found or u.email !~ '@example\.test$' or u.email_confirmed_at is null or u.deleted_at is not null or coalesce(u.is_anonymous,false) or u.banned_until>clock_timestamp() then raise exception using errcode='PT401',message='AUTH_REQUIRED'; end if;
  perform 1 from tr8_private.app_users where user_id=a and (enabled or allow_disabled) for update;
  if not found then raise exception using errcode='PT403',message='IDENTITY_DISABLED'; end if;
  select created_at,not_after into login from auth.sessions where id=s and user_id=a for share;
  if not found or exp is null or exp<=extract(epoch from clock_timestamp()) or login.not_after<=clock_timestamp() then raise exception using errcode='PT401',message='SESSION_REVOKED'; end if;
  return floor(extract(epoch from login.created_at)*1000)::bigint;
end; $$;

create function tr8_vault_control.check_envelope(e jsonb,h jsonb,a uuid) returns void
language plpgsql immutable set search_path='' as $$ begin
  if h is null or h='null'::jsonb then if e is not null and e<>'null'::jsonb then raise exception using errcode='PT409',message='HEAD_MISMATCH'; end if; return; end if;
  if not tr8_finance.valid_envelope(e) or e->>'ownerId' is distinct from a::text
    or e->>'vaultId' is distinct from h->>'vaultId' or e->>'revision' is distinct from h->>'revision'
    or e->>'keyEpoch' is distinct from h->>'keyEpoch' or e->>'credentialEpoch' is distinct from h->>'credentialEpoch'
    or e->>'operationId' is distinct from h->>'operationId'
    or encode(sha256(convert_to(tr8_vault_control.stable(e),'UTF8')),'hex') is distinct from h->>'digest' then raise exception using errcode='PT409',message='HEAD_MISMATCH'; end if;
end; $$;

create function tr8_vault_control.server(p_action text,p_actor uuid,p_session uuid,p_token_exp bigint,p_password_at bigint default null,
  p_authority_id uuid default null,p_case_id text default null,p_expected jsonb default null,p_command jsonb default null,
  p_intent jsonb default null,p_envelope jsonb default null,p_expected_revision text default null,p_operation_id text default null,p_resume boolean default false)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare created_ms bigint; local tr8_vault_control.projection; prior jsonb; c jsonb; next_state jsonb; kind text; sensitive boolean; result jsonb; target uuid; begin
  created_ms:=tr8_vault_control.live(p_actor,p_session,p_token_exp,p_authority_id,p_case_id,p_action in ('probe','operation','repair') or p_resume);
  if p_action='probe' then return jsonb_build_object('sessionCreatedAtMs',created_ms); end if;
  if p_action='operation' then
    perform tr8_finance.require_recent(p_session,p_password_at);
    select intent into result from tr8_vault_control.operations where owner_id=p_actor and operation_id=p_operation_id;
    return result;
  end if;
  select * into local from tr8_vault_control.projection where owner_id=p_actor for update;
  if not found then raise exception using errcode='PT403',message='BOOTSTRAP_REQUIRED'; end if;
  if p_action='repair' then
    perform tr8_finance.require_recent(p_session,p_password_at);
    if not (select quarantined from tr8_vault_control.config where singleton) then raise exception using errcode='PT403',message='QUARANTINE_REQUIRED'; end if;
    if p_expected->>'ownerId' is distinct from p_actor::text or not tr8_finance.epoch(p_expected->>'sequence')
      or (local.state->>'sequence')::bigint>(p_expected->>'sequence')::bigint then raise exception using errcode='PT409',message='STATE_MISMATCH'; end if;
    perform tr8_vault_control.check_envelope(p_envelope,p_expected->'head',p_actor);
    if (local.state->>'status'='deleted' and p_expected->>'status'<>'deleted') or (local.state->>'status'='disabled' and p_expected->>'status'='active')
      or not (local.state->'retiredVaults') <@ (p_expected->'retiredVaults') or not (local.state->'revokedSessions') <@ (p_expected->'revokedSessions')
      or (local.state->>'sessionEpoch')::bigint>(p_expected->>'sessionEpoch')::bigint then raise exception using errcode='PT409',message='SECURITY_FACTS_REGRESSED'; end if;
    update tr8_vault_control.projection set state=p_expected,envelope=nullif(p_envelope,'null'::jsonb) where owner_id=p_actor;
    if p_expected->>'status'<>'active' then update tr8_private.app_users set enabled=false where user_id=p_actor; end if;
    -- Repair never reenables an identity or clears quarantine. An operator must
    -- separately check the fresh independent state and release the test config.
    return jsonb_build_object('repaired',true);
  end if;
  if (select quarantined from tr8_vault_control.config where singleton) then raise exception using errcode='PT403',message='RESTORE_QUARANTINED'; end if;
  if p_action='apply' then
    if not tr8_finance.closed(p_intent,array['command','digest','next','preparedAtMs','status']) or p_intent->>'status'<>'pending' then raise exception using errcode='PT400',message='INVALID_INTENT'; end if;
    c:=p_intent->'command'; next_state:=p_intent->'next'; kind:=c->>'kind';
    select intent into prior from tr8_vault_control.operations where owner_id=p_actor and operation_id=c->>'operationId';
    if found then if prior is distinct from p_intent then raise exception using errcode='PT409',message='OPERATION_CONFLICT'; end if; return prior; end if;
  else c:=p_command; kind:=c->>'kind'; end if;
  if local.state is distinct from p_expected then raise exception using errcode='PT409',message='STATE_MISMATCH'; end if;
  if p_action='read' then
    if local.state->>'status'<>'active' or local.state#>>array['sessions',p_session::text] is distinct from local.state->>'sessionEpoch'
      or (local.state->'revokedSessions') ? p_session::text then raise exception using errcode='PT403',message='SESSION_REVOKED'; end if;
    perform tr8_vault_control.check_envelope(local.envelope,local.state->'head',p_actor);
    return jsonb_build_object('state',local.state,'envelope',local.envelope);
  end if;
  if p_action not in ('authorize','apply') or not tr8_finance.closed(c,array['ownerId','operationId','expectedSequence','kind','expectedHead','head','actorSessionId','sessionCreatedAtMs','targetSessionId'])
    or c->>'ownerId' is distinct from p_actor::text or c->>'expectedSequence' is distinct from local.state->>'sequence'
    or c->'expectedHead' is distinct from local.state->'head' or local.state->>'status'<>'active'
    or kind not in ('put','enroll','revoke','logout-all','disable','delete','reset') then raise exception using errcode='PT409',message='INVALID_COMMAND'; end if;
  if not p_resume and (c->>'actorSessionId' is distinct from p_session::text or (c->>'sessionCreatedAtMs')::bigint is distinct from created_ms) then raise exception using errcode='PT403',message='IDENTITY_MISMATCH'; end if;
  if kind='enroll' then
    if c->>'actorSessionId' is distinct from p_session::text or (c->>'sessionCreatedAtMs')::bigint is distinct from created_ms or created_ms<=(local.state->>'sessionCutoffMs')::bigint
      or local.state->'sessions' ? p_session::text or local.state->'revokedSessions' ? p_session::text then raise exception using errcode='PT403',message='SESSION_REVOKED'; end if;
  elsif local.state#>>array['sessions',c->>'actorSessionId'] is distinct from local.state->>'sessionEpoch' or local.state->'revokedSessions' ? (c->>'actorSessionId') then raise exception using errcode='PT403',message='SESSION_REVOKED'; end if;
  sensitive:=kind<>'put' or local.envelope is null or local.envelope->>'keyEpoch' is distinct from p_envelope->>'keyEpoch' or local.envelope->>'credentialEpoch' is distinct from p_envelope->>'credentialEpoch' or p_resume;
  if sensitive then perform tr8_finance.require_recent(p_session,p_password_at); end if;
  if kind='put' then
    perform tr8_vault_control.check_envelope(p_envelope,c->'head',p_actor);
    perform tr8_finance.require_transition(local.envelope,p_envelope,p_expected_revision);
    if local.state->'retiredVaults' ? (p_envelope->>'vaultId') then raise exception using errcode='PT403',message='VAULT_RETIRED'; end if;
  end if;
  if kind='revoke' then
    target:=(c->>'targetSessionId')::uuid;
    if not(local.state->'sessions' ? target::text) then raise exception using errcode='PT403',message='SESSION_REVOKED'; end if;
  end if;
  if p_action='authorize' then return jsonb_build_object('authorized',true); end if;
  if p_intent->>'digest' is distinct from encode(sha256(convert_to(tr8_vault_control.stable(c),'UTF8')),'hex')
    or next_state->>'ownerId' is distinct from p_actor::text or next_state->>'sequence' is distinct from ((local.state->>'sequence')::bigint+1)::text
    or (kind='put' and next_state->'head' is distinct from c->'head') then raise exception using errcode='PT409',message='INTENT_MISMATCH'; end if;
  update tr8_vault_control.projection set state=next_state,envelope=case when kind='put' then p_envelope when kind in ('reset','delete') then null else local.envelope end where owner_id=p_actor;
  insert into tr8_vault_control.operations values(p_actor,c->>'operationId',p_intent);
  if kind='revoke' then
    update auth.refresh_tokens set revoked=true where session_id=target;
    delete from auth.sessions where user_id=p_actor and id=target;
  elsif kind in ('logout-all','disable','delete','reset') then
    update auth.refresh_tokens set revoked=true where session_id in(select id from auth.sessions where user_id=p_actor);
    delete from auth.sessions where user_id=p_actor;
    if kind in ('disable','delete') then update tr8_private.app_users set enabled=false where user_id=p_actor; end if;
  end if;
  if p_token_exp<=extract(epoch from clock_timestamp()) then raise exception using errcode='PT401',message='SESSION_EXPIRED'; end if;
  return p_intent;
end; $$;
create function public.tr8_server_vault_control(p_action text,p_actor uuid,p_session uuid,p_token_exp bigint,p_password_at bigint default null,
  p_authority_id uuid default null,p_case_id text default null,p_expected jsonb default null,p_command jsonb default null,p_intent jsonb default null,
  p_envelope jsonb default null,p_expected_revision text default null,p_operation_id text default null,p_resume boolean default false)
returns jsonb language sql volatile security invoker set search_path='' as $$ select tr8_vault_control.server(p_action,p_actor,p_session,p_token_exp,p_password_at,p_authority_id,p_case_id,p_expected,p_command,p_intent,p_envelope,p_expected_revision,p_operation_id,p_resume); $$;
do $$ declare t text; f record; begin
  foreach t in array array['config','projection','operations'] loop
    execute format('alter table tr8_vault_control.%I enable row level security',t);
    execute format('revoke all on table tr8_vault_control.%I from public,anon,authenticated,service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tr8_vault_control' or (n.nspname='public' and p.proname='tr8_server_vault_control') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end; $$;
grant usage on schema tr8_vault_control to service_role;
grant execute on function tr8_vault_control.server(text,uuid,uuid,bigint,bigint,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,boolean),public.tr8_server_vault_control(text,uuid,uuid,bigint,bigint,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,boolean) to service_role;
