-- Synthetic 6B.5C rehearsal only. Apply to the isolated test project, not production.
-- Independent authority identity is configured explicitly, never bootstrapped by reads.
create table tr8_finance.restore_config (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  authority_id uuid,
  case_id text check(case_id in ('reset','revoke','purge'))
);
insert into tr8_finance.restore_config(singleton) values(true);
create table tr8_finance.restore_owners (
  owner_id uuid primary key references tr8_finance.actors(owner_id) on delete restrict,
  authority_id uuid not null,
  case_id text not null,
  purged boolean not null default false,
  state_hash bytea check(state_hash is null or octet_length(state_hash)=32)
);
create table tr8_finance.restore_links (
  owner_id uuid not null references tr8_finance.actors(owner_id) on delete restrict,
  operation_id text not null,
  command text not null,
  digest bytea not null check(octet_length(digest)=32),
  primary key(owner_id,operation_id)
);

-- All three cases start at epoch 1; bounded complete history is mandatory.
create function tr8_finance.restore_command(c jsonb) returns text
language plpgsql immutable set search_path='' as $$
begin
  if not tr8_finance.closed(c,array['operationId','ownerId','expectedEpoch','kind','vaultId','targetSessionId'])
    or not tr8_finance.b64(c->>'operationId',16) or not tr8_finance.epoch(c->>'expectedEpoch')
    or c->>'ownerId' is distinct from '37848d70-989a-4f69-b124-0c959d8b49a6'
    or jsonb_typeof(c->'operationId')<>'string' or jsonb_typeof(c->'expectedEpoch')<>'string'
    or c->>'kind' is null or c->>'kind' not in ('reset','revoke','purge') then raise exception using errcode='PT400',message='INVALID_COMMAND'; end if;
  if c->>'kind'='revoke' then
    if c->'vaultId' is distinct from 'null'::jsonb or jsonb_typeof(c->'targetSessionId')<>'string' or c->>'targetSessionId' is null or c->>'targetSessionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception using errcode='PT400',message='INVALID_COMMAND'; end if;
  elsif c->'vaultId' is distinct from '"AAAAAAAAAAAAAAAAAAAAAA"'::jsonb or c->'targetSessionId' is distinct from 'null'::jsonb then raise exception using errcode='PT400',message='INVALID_COMMAND'; end if;
  return '{"operationId":'||(c->'operationId')::text||',"ownerId":'||(c->'ownerId')::text||',"expectedEpoch":'||(c->'expectedEpoch')::text||',"kind":'||(c->'kind')::text||',"vaultId":'||(c->'vaultId')::text||',"targetSessionId":'||(c->'targetSessionId')::text||'}';
end; $$;

-- This gate deliberately serializes the tiny synthetic coordinator and keeps
-- quarantine locked throughout repair; it never clears quarantine to authenticate.
create function tr8_finance.restore_actor(a uuid,s uuid,exp bigint,authority uuid,case_name text,allow_quarantine boolean)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare cfg tr8_finance.config; rc tr8_finance.restore_config; u record; valid_until timestamptz; e bigint;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='READ_COMMITTED_REQUIRED'; end if;
  select * into cfg from tr8_finance.config where singleton for update;
  select * into rc from tr8_finance.restore_config where singleton for share;
  if not cfg.synthetic_enabled or not cfg.synthetic_only or (cfg.restore_quarantined and not allow_quarantine)
    or not rc.enabled or rc.authority_id is distinct from authority or rc.case_id is distinct from case_name
    or authority is null or case_name not in ('reset','revoke','purge')
    or a::text<>'37848d70-989a-4f69-b124-0c959d8b49a6'
    or not exists(select 1 from tr8_finance.synthetic_allowlist where user_id=a and synthetic_only) then raise exception using errcode='PT403',message='FINANCE_DISABLED'; end if;
  select email,email_confirmed_at,deleted_at,is_anonymous,banned_until into u from auth.users where id=a for share;
  if not found or u.email !~ '@example\.test$' or u.email_confirmed_at is null or u.deleted_at is not null or coalesce(u.is_anonymous,false) or u.banned_until>clock_timestamp() then raise exception using errcode='PT401',message='AUTH_REQUIRED'; end if;
  perform 1 from tr8_private.app_users where user_id=a and enabled for update;
  if not found then raise exception using errcode='PT403',message='IDENTITY_DISABLED'; end if;
  select not_after into valid_until from auth.sessions where id=s and user_id=a for share;
  if not found or exp is null or exp<=extract(epoch from clock_timestamp()) or valid_until<=clock_timestamp() then raise exception using errcode='PT401',message='AUTH_REQUIRED'; end if;
  insert into tr8_finance.actors(owner_id) values(a) on conflict do nothing;
  select epoch into e from tr8_finance.actors where owner_id=a for update;
  insert into tr8_finance.restore_owners(owner_id,authority_id,case_id) values(a,authority,case_name) on conflict do nothing;
  perform 1 from tr8_finance.restore_owners where owner_id=a and authority_id=authority and case_id=case_name for update;
  if not found then raise exception using errcode='PT403',message='AUTHORITY_CHANGED'; end if;
  if not allow_quarantine and exists(select 1 from tr8_finance.revoked_sessions where owner_id=a and session_id=s) then raise exception using errcode='PT403',message='SESSION_REVOKED'; end if;
  return e;
end; $$;

create function public.tr8_server_finance_coordinated(
  p_action text,p_actor uuid,p_session uuid,p_token_exp bigint,
  p_password_at bigint default null,p_body_base64 text default null,p_expected_epoch bigint default null,
  p_vault_id text default null,p_operation_id text default null,p_target_session uuid default null,
  p_authority_id uuid default null,p_case_id text default null,p_fence_epoch bigint default null,
  p_journal_command text default null,p_journal_digest text default null,p_journal_epoch bigint default null,p_state jsonb default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare e bigint; result jsonb; c jsonb; encoded text; digest bytea; prior tr8_finance.restore_links;
  item jsonb; entry jsonb; n bigint:=1; purged boolean:=false; retired text[]:='{}'; revoked text[]:='{}'; ids text[]:='{}';
  state_retired text[]; state_revoked text[]; calculated bytea; v_id text; hash bytea;
begin
  e:=tr8_finance.restore_actor(p_actor,p_session,p_token_exp,p_authority_id,p_case_id,p_action in ('repair','release'));
  if p_action in ('repair','release') then
    perform tr8_finance.require_recent(p_session,p_password_at);
    if not (select restore_quarantined from tr8_finance.config where singleton) then raise exception using errcode='PT403',message='QUARANTINE_REQUIRED'; end if;
    if not tr8_finance.closed(p_state,array['ownerId','epoch','purged','retiredVaults','revokedSessions','operations'])
      or p_state->>'ownerId'<>p_actor::text or not tr8_finance.epoch(p_state->>'epoch')
      or jsonb_typeof(p_state->'purged')<>'boolean' or jsonb_typeof(p_state->'operations')<>'array'
      or jsonb_typeof(p_state->'retiredVaults')<>'array' or jsonb_typeof(p_state->'revokedSessions')<>'array'
      or jsonb_array_length(p_state->'operations')>64 then raise exception using errcode='PT400',message='INVALID_STATE'; end if;
    for item in select value from jsonb_array_elements(p_state->'operations') loop
      if not tr8_finance.closed(item,array['command','status','receipt']) or item->>'status'<>'committed' or purged
        or not tr8_finance.closed(item->'receipt',array['operationId','epoch','digest']) then raise exception using errcode='PT409',message='INCOMPLETE_STATE'; end if;
      c:=item->'command'; encoded:=tr8_finance.restore_command(c); calculated:=sha256(convert_to(encoded,'UTF8'));
      if c->>'expectedEpoch'<>n::text or c->>'operationId'=any(ids)
        or item#>>'{receipt,operationId}'<>c->>'operationId' or item#>>'{receipt,epoch}'<>(n+1)::text
        or item#>>'{receipt,digest}'<>encode(calculated,'hex') then raise exception using errcode='PT409',message='INVALID_HISTORY'; end if;
      ids:=array_append(ids,c->>'operationId'); n:=n+1;
      if c->>'kind'='revoke' then revoked:=array_append(revoked,c->>'targetSessionId');
      else retired:=array_append(retired,c->>'vaultId'); end if;
      purged:=c->>'kind'='purge';
    end loop;
    select coalesce(array_agg(distinct value order by value),'{}') into retired from unnest(retired) value;
    select coalesce(array_agg(distinct value order by value),'{}') into revoked from unnest(revoked) value;
    select coalesce(array_agg(value order by value),'{}') into state_retired from jsonb_array_elements_text(p_state->'retiredVaults');
    select coalesce(array_agg(value order by value),'{}') into state_revoked from jsonb_array_elements_text(p_state->'revokedSessions');
    if n::text<>p_state->>'epoch' or e>n or purged<>(p_state->>'purged')::boolean or retired<>state_retired or revoked<>state_revoked
      or exists(select 1 from tr8_finance.retired where owner_id=p_actor and not(vault_id=any(retired)))
      or exists(select 1 from tr8_finance.revoked_sessions where owner_id=p_actor and not(session_id::text=any(revoked)))
      or exists(select 1 from tr8_finance.restore_owners where owner_id=p_actor and tr8_finance.restore_owners.purged and not purged)
      or exists(select 1 from tr8_finance.lifecycle_receipts where owner_id=p_actor and not(operation_id=any(ids)))
      or exists(select 1 from tr8_finance.restore_links where owner_id=p_actor and not(operation_id=any(ids))) then raise exception using errcode='PT409',message='AUTHORITY_DIVERGED'; end if;
    hash:=sha256(convert_to(p_state::text,'UTF8'));
    if p_action='release' then
      if not exists(select 1 from tr8_finance.restore_owners where owner_id=p_actor and state_hash=hash) or e<>n then raise exception using errcode='PT409',message='REPAIR_REQUIRED'; end if;
      update tr8_finance.config set restore_quarantined=false where singleton;
    else
      for item in select value from jsonb_array_elements(p_state->'operations') loop
        c:=item->'command'; encoded:=tr8_finance.restore_command(c); digest:=sha256(convert_to(encoded,'UTF8'));
        select * into prior from tr8_finance.restore_links where owner_id=p_actor and operation_id=c->>'operationId';
        if found and (prior.command<>encoded or prior.digest<>digest) then raise exception using errcode='PT409',message='OPERATION_CONFLICT'; end if;
        result:=jsonb_build_object('operationId',c->>'operationId','epoch',item#>>'{receipt,epoch}','retiredVaultId',case when c->>'kind'='revoke' then null else c->>'vaultId' end);
        calculated:=sha256(convert_to(jsonb_build_object('action',c->>'kind','epoch',(c->>'expectedEpoch')::bigint,'vault',c->>'vaultId','session',(c->>'targetSessionId')::uuid)::text,'UTF8'));
        if exists(select 1 from tr8_finance.lifecycle_receipts where owner_id=p_actor and operation_id=c->>'operationId' and (request_hash<>calculated or tr8_finance.lifecycle_receipts.result<>result)) then raise exception using errcode='PT409',message='OPERATION_CONFLICT'; end if;
        insert into tr8_finance.restore_links values(p_actor,c->>'operationId',encoded,digest) on conflict do nothing;
        insert into tr8_finance.lifecycle_receipts values(p_actor,c->>'operationId',calculated,result) on conflict do nothing;
      end loop;
      insert into tr8_finance.retired select value,p_actor from unnest(retired) value on conflict do nothing;
      insert into tr8_finance.revoked_sessions select p_actor,value::uuid from unnest(revoked) value on conflict do nothing;
      delete from tr8_finance.vaults where owner_id=p_actor and (vault_id=any(retired) or purged);
      delete from tr8_finance.receipts where owner_id=p_actor and (vault_id=any(retired) or purged);
      update tr8_finance.actors set epoch=n where owner_id=p_actor;
      update tr8_finance.restore_owners set purged=(p_state->>'purged')::boolean,state_hash=hash where owner_id=p_actor;
    end if;
    perform tr8_finance.require_recent(p_session,p_password_at);
    return jsonb_build_object('epoch',n::text,'quarantined',p_action<>'release');
  end if;
  if p_action not in ('authorize','reset','revoke','purge') and (select ro.purged from tr8_finance.restore_owners ro where owner_id=p_actor) then raise exception using errcode='PT403',message='OWNER_PURGED'; end if;
  select vault_id into v_id from tr8_finance.vaults where owner_id=p_actor;
  if p_action='metadata' then return jsonb_build_object('epoch',e::text,'vaultId',v_id,'purged',false); end if;
  if p_action='authorize' then perform tr8_finance.require_recent(p_session,p_password_at); return jsonb_build_object('authorized',true); end if;
  if p_action in ('read','put','receipt') then
    if p_fence_epoch is distinct from e then raise exception using errcode='PT409',message='LIFECYCLE_CHANGED'; end if;
    result:=tr8_finance.server(p_action,p_actor,p_session,p_token_exp,p_password_at,p_body_base64,p_expected_epoch,p_vault_id,p_operation_id,p_target_session);
    if exists(select 1 from tr8_finance.vaults where owner_id=p_actor and vault_id<>'AAAAAAAAAAAAAAAAAAAAAA') then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
    return result;
  end if;
  if p_action not in ('reset','revoke','purge') then raise exception using errcode='PT400',message='INVALID_INPUT'; end if;
  perform tr8_finance.require_recent(p_session,p_password_at);
  c:=jsonb_build_object('operationId',p_operation_id,'ownerId',p_actor::text,'expectedEpoch',p_expected_epoch::text,'kind',p_action,'vaultId',p_vault_id,'targetSessionId',p_target_session::text);
  encoded:=tr8_finance.restore_command(c); digest:=sha256(convert_to(encoded,'UTF8'));
  if encoded is distinct from p_journal_command or encode(digest,'hex') is distinct from p_journal_digest or p_journal_epoch is distinct from p_expected_epoch+1 then raise exception using errcode='PT409',message='INTENT_REQUIRED'; end if;
  select * into prior from tr8_finance.restore_links where owner_id=p_actor and operation_id=p_operation_id;
  if found then
    if prior.command<>encoded or prior.digest<>digest or e<>p_journal_epoch then raise exception using errcode='PT409',message='OPERATION_CONFLICT'; end if;
    select lr.result into result from tr8_finance.lifecycle_receipts lr where owner_id=p_actor and operation_id=p_operation_id;
    if result is null then raise exception using errcode='PT409',message='RECEIPT_MISSING'; end if;
    return result;
  end if;
  if e is distinct from p_expected_epoch then raise exception using errcode='PT409',message='LIFECYCLE_CHANGED'; end if;
  if (select ro.purged from tr8_finance.restore_owners ro where owner_id=p_actor) then raise exception using errcode='PT403',message='OWNER_PURGED'; end if;
  if p_action='revoke' then
    perform 1 from auth.sessions where id=p_target_session and user_id=p_actor for share;
    if not found then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
    insert into tr8_finance.revoked_sessions values(p_actor,p_target_session) on conflict do nothing;
  else
    if v_id is distinct from p_vault_id then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
    insert into tr8_finance.retired values(p_vault_id,p_actor);
    delete from tr8_finance.vaults where owner_id=p_actor;
    delete from tr8_finance.receipts where owner_id=p_actor;
    if p_action='purge' then update tr8_finance.restore_owners set purged=true where owner_id=p_actor; end if;
  end if;
  update tr8_finance.actors set epoch=p_journal_epoch where owner_id=p_actor;
  update tr8_finance.restore_owners set state_hash=null where owner_id=p_actor;
  result:=jsonb_build_object('operationId',p_operation_id,'epoch',p_journal_epoch::text,'retiredVaultId',case when p_action='revoke' then null else p_vault_id end);
  calculated:=sha256(convert_to(jsonb_build_object('action',p_action,'epoch',p_expected_epoch,'vault',p_vault_id,'session',p_target_session)::text,'UTF8'));
  insert into tr8_finance.lifecycle_receipts values(p_actor,p_operation_id,calculated,result);
  insert into tr8_finance.restore_links values(p_actor,p_operation_id,encoded,digest);
  perform tr8_finance.require_recent(p_session,p_password_at);
  return result;
end; $$;

do $$ declare t text; f record; begin
  foreach t in array array['restore_config','restore_owners','restore_links'] loop
    execute format('alter table tr8_finance.%I enable row level security',t);
    execute format('revoke all on table tr8_finance.%I from public,anon,authenticated,service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tr8_finance' or (n.nspname='public' and p.proname in ('tr8_server_finance','tr8_server_finance_coordinated')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end; $$;
grant execute on function public.tr8_server_finance_coordinated(text,uuid,uuid,bigint,bigint,text,bigint,text,text,uuid,uuid,text,bigint,text,text,bigint,jsonb) to service_role;
