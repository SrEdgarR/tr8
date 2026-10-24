-- 6B.1 synthetic-only authority. No production vault activation or restore claim.
-- All application/project/task data and existing Auth configuration are preserved.
create schema tr8_finance;
revoke all on schema tr8_finance from public,anon,authenticated,service_role;

create table tr8_finance.config (
  singleton boolean primary key default true check(singleton),
  synthetic_enabled boolean not null default false,
  restore_quarantined boolean not null default true,
  synthetic_only boolean not null default true check(synthetic_only)
);
insert into tr8_finance.config(singleton) values(true);
create table tr8_finance.synthetic_allowlist (
  user_id uuid primary key references tr8_private.app_users(user_id) on delete restrict,
  synthetic_only boolean not null default true check(synthetic_only)
);
create table tr8_finance.actors (
  owner_id uuid primary key references tr8_private.app_users(user_id) on delete restrict,
  epoch bigint not null default 1 check(epoch>0)
);
create table tr8_finance.vaults (
  owner_id uuid primary key references tr8_finance.actors(owner_id) on delete restrict,
  vault_id text not null unique,
  revision bigint not null check(revision>0),
  envelope jsonb not null
);
create table tr8_finance.receipts (
  owner_id uuid not null references tr8_finance.actors(owner_id) on delete restrict,
  operation_id text not null,
  vault_id text not null,
  request_hash bytea not null check(octet_length(request_hash)=32),
  revision bigint not null check(revision>0),
  primary key(owner_id,operation_id)
);
create table tr8_finance.retired (
  vault_id text primary key,
  owner_id uuid not null references tr8_finance.actors(owner_id) on delete restrict
);
create table tr8_finance.revoked_sessions (
  owner_id uuid not null references tr8_finance.actors(owner_id) on delete restrict,
  session_id uuid not null,
  primary key(owner_id,session_id)
);
create table tr8_finance.lifecycle_receipts (
  owner_id uuid not null references tr8_finance.actors(owner_id) on delete restrict,
  operation_id text not null,
  request_hash bytea not null check(octet_length(request_hash)=32),
  result jsonb not null,
  primary key(owner_id,operation_id)
);

create function tr8_finance.closed(p_value jsonb,p_fields text[])
returns boolean language plpgsql immutable set search_path='' as $$ begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  return p_value ?& p_fields and (select count(*) from jsonb_object_keys(p_value))=cardinality(p_fields);
end; $$;
create function tr8_finance.b64(p_value text,p_length integer default null)
returns boolean language plpgsql immutable set search_path='' as $$
declare b bytea; canonical text;
begin
  if p_value is null or length(p_value)>2097152 or p_value !~ '^[A-Za-z0-9_-]+$' or length(p_value)%4=1 then return false; end if;
  b:=decode(translate(p_value,'-_','+/')||repeat('=',(4-length(p_value)%4)%4),'base64');
  canonical:=rtrim(translate(replace(encode(b,'base64'),E'\n',''),'+/','-_'),'=');
  return canonical=p_value and (p_length is null or octet_length(b)=p_length);
exception when others then return false;
end; $$;
create function tr8_finance.epoch(p_value text)
returns boolean language plpgsql immutable set search_path='' as $$ begin
  return coalesce(p_value ~ '^[1-9][0-9]{0,18}$' and p_value::numeric<=9223372036854775807,false);
exception when others then return false; end; $$;

create function tr8_finance.valid_envelope(e jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare p jsonb; r jsonb; c jsonb; cipher bytea;
begin
  if not tr8_finance.closed(e,array['formatVersion','suiteId','vaultId','ownerId','keyEpoch','credentialEpoch','revision','operationId','payloadSchemaVersion','passwordWrap','recoveryWrap','payload'])
    or e->'formatVersion'<>'1'::jsonb or jsonb_typeof(e->'suiteId')<>'string' or e->>'suiteId'<>'pulso-v1-aes256gcm-hkdfsha256-argon2id13'
    or e->'payloadSchemaVersion'<>'1'::jsonb or jsonb_typeof(e->'vaultId')<>'string' or jsonb_typeof(e->'operationId')<>'string' or not tr8_finance.b64(e->>'vaultId',16) or not tr8_finance.b64(e->>'operationId',16)
    or jsonb_typeof(e->'ownerId')<>'string' or e->>'ownerId' !~ '^[!-~]{1,128}$'
    or jsonb_typeof(e->'keyEpoch')<>'string' or jsonb_typeof(e->'credentialEpoch')<>'string' or jsonb_typeof(e->'revision')<>'string'
    or not tr8_finance.epoch(e->>'keyEpoch') or not tr8_finance.epoch(e->>'credentialEpoch') or not tr8_finance.epoch(e->>'revision') then return false; end if;
  p:=e->'passwordWrap'; r:=e->'recoveryWrap'; c:=e->'payload';
  if not tr8_finance.closed(p,array['wrapVersion','slotEpoch','kdfId','argonVersion','profileId','memoryKiB','passes','parallelism','outputBytes','salt','nonce','wrappedKey'])
    or p->'wrapVersion'<>'1'::jsonb or jsonb_typeof(p->'kdfId')<>'string' or p->>'kdfId'<>'argon2id' or p->'argonVersion'<>'19'::jsonb
    or jsonb_typeof(p->'profileId')<>'string' or p->>'profileId'<>'argon2id-64m-t3-p1-v1' or p->'memoryKiB'<>'65536'::jsonb or p->'passes'<>'3'::jsonb or p->'parallelism'<>'1'::jsonb or p->'outputBytes'<>'32'::jsonb
    or jsonb_typeof(p->'slotEpoch')<>'string' or not tr8_finance.epoch(p->>'slotEpoch')
    or jsonb_typeof(p->'salt')<>'string' or jsonb_typeof(p->'nonce')<>'string' or jsonb_typeof(p->'wrappedKey')<>'string'
    or not tr8_finance.b64(p->>'salt',16) or not tr8_finance.b64(p->>'nonce',12) or not tr8_finance.b64(p->>'wrappedKey',48) then return false; end if;
  if not tr8_finance.closed(r,array['wrapVersion','slotEpoch','schemeId','salt','nonce','wrappedKey'])
    or r->'wrapVersion'<>'1'::jsonb or jsonb_typeof(r->'schemeId')<>'string' or r->>'schemeId'<>'HKDF-SHA-256' or jsonb_typeof(r->'slotEpoch')<>'string' or not tr8_finance.epoch(r->>'slotEpoch')
    or jsonb_typeof(r->'salt')<>'string' or jsonb_typeof(r->'nonce')<>'string' or jsonb_typeof(r->'wrappedKey')<>'string'
    or not tr8_finance.b64(r->>'salt',32) or not tr8_finance.b64(r->>'nonce',12) or not tr8_finance.b64(r->>'wrappedKey',48) then return false; end if;
  if not tr8_finance.closed(c,array['keySalt','nonce','ciphertext']) or jsonb_typeof(c->'keySalt')<>'string' or jsonb_typeof(c->'nonce')<>'string' or jsonb_typeof(c->'ciphertext')<>'string' or not tr8_finance.b64(c->>'keySalt',32) or not tr8_finance.b64(c->>'nonce',12) or not tr8_finance.b64(c->>'ciphertext') then return false; end if;
  cipher:=decode(translate(c->>'ciphertext','-_','+/')||repeat('=',(4-length(c->>'ciphertext')%4)%4),'base64');
  return octet_length(cipher)>16 and octet_length(cipher)<=1048592 and octet_length(convert_to(e::text,'UTF8'))<=2097152;
exception when others then return false;
end; $$;

create function tr8_finance.require_transition(old jsonb,e jsonb,expected text)
returns void language plpgsql immutable set search_path='' as $$
declare revision text:=coalesce(old->>'revision','0'); changed boolean; rekey boolean; key text; before_wrap jsonb; after_wrap jsonb;
begin
  if expected is distinct from revision then raise exception using errcode='PT409',message='STALE_REVISION'; end if;
  if e->>'revision' is distinct from (revision::numeric+1)::text then raise exception using errcode='PT400',message='INVALID_ENVELOPE'; end if;
  if old is null then
    if e->>'keyEpoch'<>'1' or e->>'credentialEpoch'<>'1' or e#>>'{passwordWrap,slotEpoch}'<>'1' or e#>>'{recoveryWrap,slotEpoch}'<>'1' then raise exception using errcode='PT400',message='INVALID_ENVELOPE'; end if;
    return;
  end if;
  if old->>'ownerId' is distinct from e->>'ownerId' or old->>'vaultId' is distinct from e->>'vaultId' then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
  rekey:=e->>'keyEpoch'<>old->>'keyEpoch';
  if (e->>'keyEpoch')::numeric<>(old->>'keyEpoch')::numeric+(case when rekey then 1 else 0 end)
    or (e->>'credentialEpoch')::numeric<>(old->>'credentialEpoch')::numeric+(case when old->'passwordWrap'<>e->'passwordWrap' or old->'recoveryWrap'<>e->'recoveryWrap' then 1 else 0 end)
    or (rekey and (old->'passwordWrap'=e->'passwordWrap' or old->'recoveryWrap'=e->'recoveryWrap'))
    or old#>>'{payload,keySalt}'=e#>>'{payload,keySalt}' or old#>>'{payload,nonce}'=e#>>'{payload,nonce}' then raise exception using errcode='PT400',message='INVALID_ENVELOPE'; end if;
  foreach key in array array['passwordWrap','recoveryWrap'] loop
    before_wrap:=old->key; after_wrap:=e->key; changed:=before_wrap<>after_wrap;
    if (after_wrap->>'slotEpoch')::numeric<>(before_wrap->>'slotEpoch')::numeric+(case when changed then 1 else 0 end)
      or (changed and (before_wrap->>'salt'=after_wrap->>'salt' or before_wrap->>'nonce'=after_wrap->>'nonce' or before_wrap->>'wrappedKey'=after_wrap->>'wrappedKey')) then raise exception using errcode='PT400',message='INVALID_ENVELOPE'; end if;
  end loop;
end; $$;

-- Locks are held to commit, including the actual Auth rows touched by logout,
-- ban/delete and application disable. FOR KEY SHARE would not stop non-key bans.
create function tr8_finance.require_actor(p_actor uuid,p_session uuid,p_token_exp bigint)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare v_epoch bigint; v_after timestamptz; u record; a_enabled boolean;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='READ_COMMITTED_REQUIRED'; end if;
  perform 1 from tr8_finance.config where singleton and synthetic_enabled and synthetic_only and not restore_quarantined for share;
  if not found then raise exception using errcode='PT403',message='FINANCE_DISABLED'; end if;
  perform 1 from tr8_finance.synthetic_allowlist where user_id=p_actor and synthetic_only for share;
  if not found then raise exception using errcode='PT403',message='FINANCE_DISABLED'; end if;
  select email_confirmed_at,deleted_at,is_anonymous,banned_until into u from auth.users where id=p_actor for share;
  if not found or u.email_confirmed_at is null or u.deleted_at is not null or coalesce(u.is_anonymous,false) or (u.banned_until is not null and u.banned_until>clock_timestamp()) then raise exception using errcode='PT401',message='AUTH_REQUIRED'; end if;
  select enabled into a_enabled from tr8_private.app_users where user_id=p_actor for update;
  if not found or not a_enabled then raise exception using errcode='PT403',message='IDENTITY_DISABLED'; end if;
  select not_after into v_after from auth.sessions where id=p_session and user_id=p_actor for share;
  if not found then raise exception using errcode='PT401',message='SESSION_REVOKED'; end if;
  insert into tr8_finance.actors(owner_id) values(p_actor) on conflict(owner_id) do nothing;
  select epoch into v_epoch from tr8_finance.actors where owner_id=p_actor for update;
  if p_token_exp is null or p_token_exp<=extract(epoch from clock_timestamp()) or (v_after is not null and v_after<=clock_timestamp())
    or exists(select 1 from tr8_finance.revoked_sessions where owner_id=p_actor and session_id=p_session) then raise exception using errcode='PT401',message='SESSION_REVOKED'; end if;
  return v_epoch;
end; $$;

create function tr8_finance.require_recent(p_session uuid,p_password_at bigint)
returns void language plpgsql volatile security definer set search_path='' as $$
declare authenticated timestamptz;
begin
  -- Compare signed JWT AMR to the server-owned Auth record. iat, refresh and
  -- client metadata are never accepted as proof, including from a fresh token.
  select updated_at into authenticated from auth.mfa_amr_claims where session_id=p_session and authentication_method='password' for share;
  if not found or p_password_at is null or floor(extract(epoch from authenticated))<>p_password_at
    or authenticated>clock_timestamp() or authenticated<=clock_timestamp()-interval '5 minutes'
    or p_password_at>extract(epoch from clock_timestamp()) or p_password_at<=extract(epoch from clock_timestamp()-interval '5 minutes') then
    raise exception using errcode='PT428',message='REAUTHENTICATION_REQUIRED';
  end if;
end; $$;

create function tr8_finance.server(p_action text,p_actor uuid,p_session uuid,p_token_exp bigint,p_password_at bigint default null,p_body_base64 text default null,p_expected_epoch bigint default null,p_vault_id text default null,p_operation_id text default null,p_target_session uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_epoch bigint; raw bytea; source text; body jsonb; e jsonb; current_vault tr8_finance.vaults; prior tr8_finance.receipts; lifecycle tr8_finance.lifecycle_receipts; request_hash bytea; result jsonb; sensitive boolean:=false;
begin
  v_epoch:=tr8_finance.require_actor(p_actor,p_session,p_token_exp);
  if p_action='read' then
    select * into current_vault from tr8_finance.vaults where owner_id=p_actor;
    if current_vault.vault_id is not null and exists(select 1 from tr8_finance.retired where vault_id=current_vault.vault_id) then raise exception using errcode='PT403',message='VAULT_RETIRED'; end if;
    result:=jsonb_build_object('envelope',current_vault.envelope,'epoch',v_epoch::text);
  elsif p_action='put' then
    if p_body_base64 is null or length(p_body_base64)>2796204 then raise exception using errcode='PT413',message='ENVELOPE_TOO_LARGE'; end if;
    begin
      raw:=decode(p_body_base64,'base64'); source:=convert_from(raw,'UTF8');
      if octet_length(raw)>2097152 then raise exception using errcode='PT413',message='ENVELOPE_TOO_LARGE'; end if;
      if not (source is json object with unique keys) then raise exception using errcode='PT400',message='INVALID_INPUT'; end if;
      body:=source::jsonb;
    exception when sqlstate 'PT413' then raise; when others then raise exception using errcode='PT400',message='INVALID_INPUT'; end;
    if not tr8_finance.closed(body,array['expectedRevision','operationId','envelope']) or jsonb_typeof(body->'expectedRevision')<>'string'
      or not (body->>'expectedRevision'='0' or tr8_finance.epoch(body->>'expectedRevision')) then raise exception using errcode='PT400',message='INVALID_INPUT'; end if;
    e:=body->'envelope';
    if not tr8_finance.valid_envelope(e) or jsonb_typeof(body->'operationId')<>'string' or body->>'operationId' is distinct from e->>'operationId' then raise exception using errcode='PT400',message='INVALID_ENVELOPE'; end if;
    if e->>'ownerId' is distinct from p_actor::text then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
    -- Serialize claims on a global context ID as well as the owner authority.
    perform pg_advisory_xact_lock(hashtextextended('tr8-finance-vault:'||(e->>'vaultId'),0));
    if exists(select 1 from tr8_finance.retired where vault_id=e->>'vaultId') then raise exception using errcode='PT403',message='VAULT_RETIRED'; end if;
    if exists(select 1 from tr8_finance.vaults where vault_id=e->>'vaultId' and owner_id<>p_actor) then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
    if p_expected_epoch is distinct from v_epoch then raise exception using errcode='PT409',message='LIFECYCLE_CHANGED'; end if;
    request_hash:=sha256(raw);
    select * into prior from tr8_finance.receipts where owner_id=p_actor and operation_id=e->>'operationId';
    if found then
      if prior.request_hash<>request_hash then raise exception using errcode='PT409',message='OPERATION_CONFLICT'; end if;
      result:=jsonb_build_object('operationId',prior.operation_id,'revision',prior.revision::text);
    else
      select * into current_vault from tr8_finance.vaults where owner_id=p_actor;
      perform tr8_finance.require_transition(current_vault.envelope,e,body->>'expectedRevision');
      sensitive:=current_vault.owner_id is null or current_vault.envelope->>'keyEpoch'<>e->>'keyEpoch';
      if sensitive then perform tr8_finance.require_recent(p_session,p_password_at); end if;
      insert into tr8_finance.vaults(owner_id,vault_id,revision,envelope) values(p_actor,e->>'vaultId',(e->>'revision')::bigint,e)
        on conflict(owner_id) do update set vault_id=excluded.vault_id,revision=excluded.revision,envelope=excluded.envelope;
      insert into tr8_finance.receipts(owner_id,operation_id,vault_id,request_hash,revision) values(p_actor,e->>'operationId',e->>'vaultId',request_hash,(e->>'revision')::bigint);
      result:=jsonb_build_object('operationId',e->>'operationId','revision',e->>'revision');
    end if;
  elsif p_action='receipt' then
    if not tr8_finance.b64(p_vault_id,16) or not tr8_finance.b64(p_operation_id,16) then raise exception using errcode='PT400',message='INVALID_INPUT'; end if;
    if exists(select 1 from tr8_finance.retired where vault_id=p_vault_id) then raise exception using errcode='PT403',message='VAULT_RETIRED'; end if;
    if p_expected_epoch is distinct from v_epoch then raise exception using errcode='PT409',message='LIFECYCLE_CHANGED'; end if;
    select * into prior from tr8_finance.receipts where owner_id=p_actor and operation_id=p_operation_id and vault_id=p_vault_id;
    if not found then raise exception using errcode='PT404',message='NOT_FOUND'; end if;
    result:=jsonb_build_object('operationId',prior.operation_id,'revision',prior.revision::text);
  elsif p_action in('reset','revoke') then
    if not tr8_finance.b64(p_operation_id,16) then raise exception using errcode='PT400',message='INVALID_INPUT'; end if;
    perform tr8_finance.require_recent(p_session,p_password_at); sensitive:=true;
    request_hash:=sha256(convert_to(jsonb_build_object('action',p_action,'epoch',p_expected_epoch,'vault',p_vault_id,'session',p_target_session)::text,'UTF8'));
    select * into lifecycle from tr8_finance.lifecycle_receipts where owner_id=p_actor and operation_id=p_operation_id;
    if found then
      if lifecycle.request_hash<>request_hash then raise exception using errcode='PT409',message='OPERATION_CONFLICT'; end if;
      result:=lifecycle.result;
    else
      if p_expected_epoch is distinct from v_epoch then raise exception using errcode='PT409',message='LIFECYCLE_CHANGED'; end if;
      if p_action='reset' then
        select * into current_vault from tr8_finance.vaults where owner_id=p_actor;
        if not tr8_finance.b64(p_vault_id,16) or current_vault.vault_id is distinct from p_vault_id then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
        perform pg_advisory_xact_lock(hashtextextended('tr8-finance-vault:'||p_vault_id,0));
        insert into tr8_finance.retired(vault_id,owner_id) values(p_vault_id,p_actor);
        delete from tr8_finance.vaults where owner_id=p_actor;
        insert into tr8_finance.revoked_sessions(owner_id,session_id) select p_actor,id from auth.sessions where user_id=p_actor and id<>p_session on conflict do nothing;
      else
        if p_target_session is null or not exists(select 1 from auth.sessions where id=p_target_session and user_id=p_actor) then raise exception using errcode='PT403',message='CONTEXT_DENIED'; end if;
        -- Self-revocation is allowed but acknowledged without another live check.
        insert into tr8_finance.revoked_sessions(owner_id,session_id) values(p_actor,p_target_session) on conflict do nothing;
      end if;
      update tr8_finance.actors set epoch=epoch+1 where owner_id=p_actor returning epoch into v_epoch;
      result:=jsonb_build_object('operationId',p_operation_id,'epoch',v_epoch::text,'retiredVaultId',case when p_action='reset' then p_vault_id else null end);
      insert into tr8_finance.lifecycle_receipts(owner_id,operation_id,request_hash,result) values(p_actor,p_operation_id,request_hash,result);
    end if;
  else raise exception using errcode='PT400',message='INVALID_INPUT'; end if;
  -- A wait for a context/receipt constraint must not acknowledge an expired JWT
  -- or login. A failure rolls the entire snapshot/receipt transaction back.
  if p_token_exp<=extract(epoch from clock_timestamp()) or exists(select 1 from auth.sessions where id=p_session and not_after<=clock_timestamp()) then raise exception using errcode='PT401',message='SESSION_REVOKED'; end if;
  if not(p_action='revoke' and p_target_session=p_session) then perform tr8_finance.require_actor(p_actor,p_session,p_token_exp); end if;
  if sensitive then perform tr8_finance.require_recent(p_session,p_password_at); end if;
  return result;
end; $$;

create function public.tr8_server_finance(p_action text,p_actor uuid,p_session uuid,p_token_exp bigint,p_password_at bigint default null,p_body_base64 text default null,p_expected_epoch bigint default null,p_vault_id text default null,p_operation_id text default null,p_target_session uuid default null)
returns jsonb language sql volatile security invoker set search_path='' as $$
  select tr8_finance.server(p_action,p_actor,p_session,p_token_exp,p_password_at,p_body_base64,p_expected_epoch,p_vault_id,p_operation_id,p_target_session);
$$;

do $$ declare t text; f record; begin
  foreach t in array array['config','synthetic_allowlist','actors','vaults','receipts','retired','revoked_sessions','lifecycle_receipts'] loop
    execute format('alter table tr8_finance.%I enable row level security',t);
    execute format('revoke all on table tr8_finance.%I from public,anon,authenticated,service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tr8_finance' or (n.nspname='public' and p.proname='tr8_server_finance') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end; $$;
grant usage on schema tr8_finance to service_role;
grant execute on function tr8_finance.server(text,uuid,uuid,bigint,bigint,text,bigint,text,text,uuid),public.tr8_server_finance(text,uuid,uuid,bigint,bigint,text,bigint,text,text,uuid) to service_role;
