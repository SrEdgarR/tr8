-- LOCAL REVIEW DRAFT. Disabled, with no registered clients or real grants.
-- These opaque tokens are NOT Supabase JWTs or personal MCP keys. They cannot
-- authenticate to Auth, Storage, project/task RPCs or the encrypted vault.
create table tr8_private.mcp_oauth_config (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 issuer text not null default 'https://tr8.vercel.app' check(issuer='https://tr8.vercel.app'),
 resource text not null default 'https://tr8.vercel.app/api/mcp/finance' check(resource='https://tr8.vercel.app/api/mcp/finance')
);
insert into tr8_private.mcp_oauth_config(singleton) values(true);
create table tr8_private.mcp_oauth_clients (
 client_id text primary key check(client_id ~ '^[A-Za-z0-9._~-]{1,128}$'),
 client_name text not null check(length(client_name) between 1 and 100),
 redirect_uris text[] not null check(cardinality(redirect_uris) between 1 and 8),
 enabled boolean not null default false
);
create table tr8_private.mcp_oauth_attempts (
 id uuid primary key default gen_random_uuid(), attempt_hash text not null unique,
 client_id text not null references tr8_private.mcp_oauth_clients(client_id) on delete restrict,
 redirect_uri text not null, code_challenge text not null, state text, scopes text[] not null,
 resource text not null, owner_id uuid references auth.users(id) on delete cascade,
 session_id uuid, status text not null default 'pending' check(status in ('pending','approved','denied')),
 created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null default clock_timestamp()+interval '10 minutes'
);
create index mcp_oauth_attempt_expiry on tr8_private.mcp_oauth_attempts(expires_at);
create table tr8_private.mcp_oauth_grants (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 credential_id uuid not null references tr8_private.mcp_credentials(id) on delete cascade,
 client_id text not null references tr8_private.mcp_oauth_clients(client_id) on delete restrict,
 scopes text[] not null, resource text not null, parent_fingerprint text not null,
 created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
 revoked_at timestamptz
);
create index mcp_oauth_grant_owner on tr8_private.mcp_oauth_grants(owner_id,id);
create index mcp_oauth_grant_credential on tr8_private.mcp_oauth_grants(credential_id,id);
create table tr8_private.mcp_oauth_codes (
 code_hash text primary key, grant_id uuid not null references tr8_private.mcp_oauth_grants(id) on delete cascade,
 client_id text not null, redirect_uri text not null, code_challenge text not null,
 expires_at timestamptz not null, consumed_at timestamptz, failures integer not null default 0
);
create index mcp_oauth_code_grant on tr8_private.mcp_oauth_codes(grant_id);
create table tr8_private.mcp_oauth_access (
 token_hash text primary key, grant_id uuid not null references tr8_private.mcp_oauth_grants(id) on delete cascade,
 scopes text[] not null, expires_at timestamptz not null, revoked_at timestamptz
);
create index mcp_oauth_access_grant on tr8_private.mcp_oauth_access(grant_id);
create table tr8_private.mcp_oauth_refresh (
 token_hash text primary key, grant_id uuid not null references tr8_private.mcp_oauth_grants(id) on delete cascade,
 scopes text[] not null, expires_at timestamptz not null, consumed_at timestamptz
);
create index mcp_oauth_refresh_grant on tr8_private.mcp_oauth_refresh(grant_id);
do $$declare t text; begin
 foreach t in array array['mcp_oauth_config','mcp_oauth_clients','mcp_oauth_attempts','mcp_oauth_grants','mcp_oauth_codes','mcp_oauth_access','mcp_oauth_refresh'] loop
  execute format('alter table tr8_private.%I enable row level security',t);
  execute format('revoke all on tr8_private.%I from public,anon,authenticated,service_role',t);
 end loop;
end;$$;

create function tr8_private.mcp_oauth_server(p_action text,p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c tr8_private.mcp_oauth_clients; g tr8_private.mcp_oauth_grants; a tr8_private.mcp_oauth_attempts;
 code tr8_private.mcp_oauth_codes; r tr8_private.mcp_oauth_refresh; t tr8_private.mcp_oauth_access;
 scopes text[]; raw text; grant_id uuid; hash text; challenge text; cfg tr8_private.mcp_oauth_config;
begin
 perform tr8_private.mcp_oauth_require_config();
 if p_input is null or jsonb_typeof(p_input) is distinct from 'object' or octet_length(p_input::text)>16384 then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 select * into cfg from tr8_private.mcp_oauth_config where singleton;
 if p_action='get_client' then
  perform tr8_private.mcp_keys(p_input,array['client_id'],array['client_id']);
  if jsonb_typeof(p_input->'client_id') is distinct from 'string' then perform tr8_private.mcp_oauth_fail('invalid_client');end if;
  if not exists(select 1 from tr8_private.mcp_oauth_clients where client_id=p_input->>'client_id' and enabled) then return null;end if;
  c:=tr8_private.mcp_oauth_client(p_input->>'client_id');
  return jsonb_build_object('client_id',c.client_id,'client_name',c.client_name,'redirect_uris',to_jsonb(c.redirect_uris),'token_endpoint_auth_method','none','grant_types',jsonb_build_array('authorization_code','refresh_token'),'response_types',jsonb_build_array('code'));
 elsif p_action='begin' then
  perform tr8_private.mcp_keys(p_input,array['client_id','redirect_uri','code_challenge','state','scopes','resource'],array['client_id','redirect_uri','code_challenge','scopes','resource']);
  c:=tr8_private.mcp_oauth_client(p_input->>'client_id');
  scopes:=tr8_private.mcp_oauth_scopes(p_input->'scopes');
  if jsonb_typeof(p_input->'redirect_uri') is distinct from 'string' or not (p_input->>'redirect_uri'=any(c.redirect_uris))
   or jsonb_typeof(p_input->'resource') is distinct from 'string' or p_input->>'resource'<>cfg.resource
   or jsonb_typeof(p_input->'code_challenge') is distinct from 'string' or p_input->>'code_challenge' !~ '^[A-Za-z0-9_-]{43}$'
   or (p_input?'state' and (jsonb_typeof(p_input->'state') is distinct from 'string' or octet_length(p_input->>'state')>2048 or p_input->>'state' ~ '[[:cntrl:]]'))
  then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
  perform pg_advisory_xact_lock(hashtextextended('tr8-mcp-oauth-attempt-budget',0));
  delete from tr8_private.mcp_oauth_attempts where expires_at<=clock_timestamp();
  if (select count(*) from tr8_private.mcp_oauth_attempts)>=1000 then perform tr8_private.mcp_oauth_fail('temporarily_unavailable');end if;
  raw:='tr8_oauth_p_'||encode(extensions.gen_random_bytes(32),'hex');
  insert into tr8_private.mcp_oauth_attempts(attempt_hash,client_id,redirect_uri,code_challenge,state,scopes,resource)
   values(tr8_private.mcp_oauth_hash(raw),c.client_id,p_input->>'redirect_uri',p_input->>'code_challenge',p_input->>'state',scopes,cfg.resource) returning * into a;
  return jsonb_build_object('attempt',raw,'expires_at',tr8_private.mcp_finance_utc(a.expires_at));
 elsif p_action='challenge' then
  perform tr8_private.mcp_keys(p_input,array['client_id','code'],array['client_id','code']);
  c:=tr8_private.mcp_oauth_client(p_input->>'client_id');
  if jsonb_typeof(p_input->'code') is distinct from 'string' or p_input->>'code' !~ '^tr8_oauth_c_[a-f0-9]{64}$' then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  select * into code from tr8_private.mcp_oauth_codes where code_hash=tr8_private.mcp_oauth_hash(p_input->>'code') and client_id=c.client_id and consumed_at is null and expires_at>clock_timestamp();
  if not found then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  g:=tr8_private.mcp_oauth_grant(code.grant_id);
  return jsonb_build_object('code_challenge',code.code_challenge);
 elsif p_action='exchange' then
  perform tr8_private.mcp_keys(p_input,array['client_id','code','code_verifier','redirect_uri','resource'],array['client_id','code','code_verifier','redirect_uri','resource']);
  c:=tr8_private.mcp_oauth_client(p_input->>'client_id');
  if jsonb_typeof(p_input->'code') is distinct from 'string' or p_input->>'code' !~ '^tr8_oauth_c_[a-f0-9]{64}$' then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  select x.grant_id into grant_id from tr8_private.mcp_oauth_codes x where x.code_hash=tr8_private.mcp_oauth_hash(p_input->>'code') and x.client_id=c.client_id;
  if not found then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  g:=tr8_private.mcp_oauth_grant(grant_id);
  select * into code from tr8_private.mcp_oauth_codes where code_hash=tr8_private.mcp_oauth_hash(p_input->>'code') for update;
  if not found or code.consumed_at is not null or code.failures>=5 or code.expires_at<=clock_timestamp()
   or jsonb_typeof(p_input->'redirect_uri') is distinct from 'string' or p_input->>'redirect_uri'<>code.redirect_uri
   or jsonb_typeof(p_input->'resource') is distinct from 'string' or p_input->>'resource'<>g.resource
  then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  if jsonb_typeof(p_input->'code_verifier') is distinct from 'string' or p_input->>'code_verifier' !~ '^[A-Za-z0-9._~-]{43,128}$' then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  challenge:=rtrim(translate(encode(sha256(convert_to(p_input->>'code_verifier','UTF8')),'base64'),'+/','-_'),'=');
  if challenge<>code.code_challenge then
   update tr8_private.mcp_oauth_codes set failures=failures+1 where code_hash=code.code_hash;
   return tr8_private.mcp_oauth_error('invalid_grant');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tr8-mcp-oauth-owner:'||g.owner_id::text,0));
  if code.expires_at<=clock_timestamp() then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  update tr8_private.mcp_oauth_codes set consumed_at=clock_timestamp() where code_hash=code.code_hash;
  return tr8_private.mcp_oauth_issue(g,g.scopes);
 elsif p_action='refresh' then
  perform tr8_private.mcp_keys(p_input,array['client_id','refresh_token','scopes','resource'],array['client_id','refresh_token','resource']);
  c:=tr8_private.mcp_oauth_client(p_input->>'client_id');
  if jsonb_typeof(p_input->'refresh_token') is distinct from 'string' or p_input->>'refresh_token' !~ '^tr8_oauth_r_[a-f0-9]{64}$' then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  select x.grant_id into grant_id from tr8_private.mcp_oauth_refresh x join tr8_private.mcp_oauth_grants q on q.id=x.grant_id
   where x.token_hash=tr8_private.mcp_oauth_hash(p_input->>'refresh_token') and q.client_id=c.client_id;
  if not found then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  g:=tr8_private.mcp_oauth_grant(grant_id);
  select * into r from tr8_private.mcp_oauth_refresh where token_hash=tr8_private.mcp_oauth_hash(p_input->>'refresh_token') for update;
  if r.consumed_at is not null then
   update tr8_private.mcp_oauth_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=g.id;
   return tr8_private.mcp_oauth_error('invalid_grant');
  end if;
  if r.expires_at<=clock_timestamp() or jsonb_typeof(p_input->'resource') is distinct from 'string' or p_input->>'resource'<>g.resource then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
  scopes:=case when p_input?'scopes' then tr8_private.mcp_oauth_scopes(p_input->'scopes') else r.scopes end;
  if not scopes<@r.scopes then perform tr8_private.mcp_oauth_fail('invalid_scope');end if;
  perform pg_advisory_xact_lock(hashtextextended('tr8-mcp-oauth-owner:'||g.owner_id::text,0));
  update tr8_private.mcp_oauth_refresh set consumed_at=clock_timestamp() where token_hash=r.token_hash;
  return tr8_private.mcp_oauth_issue(g,scopes);
 elsif p_action='verify' then
  perform tr8_private.mcp_keys(p_input,array['token','resource'],array['token','resource']);
  if jsonb_typeof(p_input->'token') is distinct from 'string' or p_input->>'token' !~ '^tr8_oauth_a_[a-f0-9]{64}$' then perform tr8_private.mcp_oauth_fail('invalid_token');end if;
  select * into t from tr8_private.mcp_oauth_access where token_hash=tr8_private.mcp_oauth_hash(p_input->>'token');
  if not found then perform tr8_private.mcp_oauth_fail('invalid_token');end if;
  g:=tr8_private.mcp_oauth_grant(t.grant_id);
  select * into t from tr8_private.mcp_oauth_access where token_hash=t.token_hash for share;
  if t.revoked_at is not null or t.expires_at<=clock_timestamp() or g.expires_at<=clock_timestamp()
   or jsonb_typeof(p_input->'resource') is distinct from 'string' or p_input->>'resource'<>g.resource
  then perform tr8_private.mcp_oauth_fail('invalid_token');end if;
  return jsonb_build_object('client_id',g.client_id,'scopes',to_jsonb(t.scopes),'expires_at',tr8_private.mcp_finance_utc(least(t.expires_at,g.expires_at)),'resource',g.resource,'grant_id',g.id);
 elsif p_action='revoke' then
  perform tr8_private.mcp_keys(p_input,array['client_id','token','token_type_hint'],array['client_id','token']);
  c:=tr8_private.mcp_oauth_client(p_input->>'client_id');
  if jsonb_typeof(p_input->'token') is distinct from 'string' or length(p_input->>'token')>100 then return '{}'::jsonb;end if;
  hash:=tr8_private.mcp_oauth_hash(p_input->>'token');
  select x.grant_id into grant_id from (select oa.grant_id from tr8_private.mcp_oauth_access oa where oa.token_hash=hash union all select orf.grant_id from tr8_private.mcp_oauth_refresh orf where orf.token_hash=hash)x
   join tr8_private.mcp_oauth_grants q on q.id=x.grant_id where q.client_id=c.client_id limit 1;
  if not found then return '{}'::jsonb;end if;
  -- Revocation remains possible after expiry or parent-scope changes.
  select * into g from tr8_private.mcp_oauth_grants where id=grant_id;
  perform tr8_private.v2_lock_workspace((select workspace_id from tr8_private.mcp_credentials where id=g.credential_id));
  perform 1 from tr8_private.mcp_credentials where id=g.credential_id for update;
  update tr8_private.mcp_oauth_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=g.id;
  return '{}'::jsonb;
 end if;
 perform tr8_private.mcp_oauth_fail('invalid_request');
exception when others then
 return tr8_private.mcp_oauth_error(case when p_action='verify' and sqlstate='P0001' and sqlerrm='invalid_grant' then 'invalid_token' when sqlstate='P0001' and sqlerrm in ('invalid_client','invalid_grant','invalid_request','invalid_scope','invalid_token','temporarily_unavailable') then sqlerrm when sqlstate like '22%' or sqlstate='23514' then 'invalid_request' else 'server_error' end);
end;$$;

create function tr8_private.mcp_oauth_error(code text) returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('_tr8_oauth_error',jsonb_build_object('code',code));
$$;
create function tr8_private.mcp_oauth_fail(code text) returns void language plpgsql immutable security invoker set search_path='' as $$begin raise exception using errcode='P0001',message=code;end;$$;
create function tr8_private.mcp_oauth_hash(value text) returns text language sql immutable security invoker set search_path='' as $$select encode(sha256(convert_to(value,'UTF8')),'hex');$$;
create function tr8_private.mcp_oauth_scopes(input jsonb) returns text[] language plpgsql immutable security invoker set search_path='' as $$
declare scopes text[]; begin
 if jsonb_typeof(input) is distinct from 'array' or jsonb_array_length(input) not between 1 and 2
  or exists(select 1 from jsonb_array_elements(input)x where jsonb_typeof(x) is distinct from 'string' or x#>>'{}' not in ('finance:read','finance:write'))
 then perform tr8_private.mcp_oauth_fail('invalid_scope'); end if;
 scopes:=array(select jsonb_array_elements_text(input));
 if not 'finance:read'=any(scopes) or cardinality(scopes)<>(select count(distinct s) from unnest(scopes)s) then perform tr8_private.mcp_oauth_fail('invalid_scope');end if;
 return array(select s from unnest(scopes)s order by s);
end;$$;
create function tr8_private.mcp_oauth_require_config() returns void language plpgsql volatile security invoker set search_path='' as $$begin
 perform 1 from tr8_private.mcp_oauth_config where singleton and enabled for share;
 if not found then perform tr8_private.mcp_oauth_fail('temporarily_unavailable');end if;
end;$$;
create function tr8_private.mcp_oauth_client(p_client text) returns tr8_private.mcp_oauth_clients language plpgsql volatile security invoker set search_path='' as $$
declare c tr8_private.mcp_oauth_clients; begin
 select * into c from tr8_private.mcp_oauth_clients where client_id=p_client and enabled for share;
 if not found or exists(select 1 from unnest(c.redirect_uris)u where u !~ '^https://[^/?#@[:space:]]+(/[^#[:space:]]*)?$')
 then perform tr8_private.mcp_oauth_fail('invalid_client');end if;
 return c;
end;$$;
-- Match the existing delegated lock order. All grant configuration mutations
-- take this parent credential lock, so a narrowed/revoked scope is immediate.
create function tr8_private.mcp_oauth_parent(p_id uuid) returns tr8_private.mcp_credentials language plpgsql volatile security invoker set search_path='' as $$
declare c tr8_private.mcp_credentials; w uuid; begin
 select workspace_id into w from tr8_private.mcp_credentials where id=p_id;
 if not found then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 perform tr8_private.v2_lock_workspace(w);
 select * into c from tr8_private.mcp_credentials where id=p_id for update;
 if not found or c.revoked_at is not null or c.expires_at<=clock_timestamp() then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 perform 1 from auth.users where id=c.owner_id for share;
 perform 1 from tr8_private.app_users where user_id=c.owner_id and enabled for share;
 if not found or not tr8_private.v2_user_live(c.owner_id)
  or not exists(select 1 from tr8_private.workspaces where id=w and owner_id=c.owner_id and kind='personal')
  or not exists(select 1 from tr8_private.workspace_members where workspace_id=w and user_id=c.owner_id and status='active')
 then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 perform 1 from tr8_private.mcp_finance_grants where credential_id=c.id and owner_id=c.owner_id for share;
 if not found then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 return c;
end;$$;
create function tr8_private.mcp_oauth_fingerprint(p_id uuid) returns text language sql stable security invoker set search_path='' as $$
 select tr8_private.mcp_finance_hash(tr8_private.mcp_finance_grant_json(g)||jsonb_build_object('revision',tr8_private.mcp_finance_utc(g.updated_at))) from tr8_private.mcp_finance_grants g where g.credential_id=p_id;
$$;
create function tr8_private.mcp_oauth_grant(p_id uuid) returns tr8_private.mcp_oauth_grants language plpgsql volatile security invoker set search_path='' as $$
declare g tr8_private.mcp_oauth_grants; c tr8_private.mcp_credentials; parent uuid; begin
 select credential_id into parent from tr8_private.mcp_oauth_grants where id=p_id;
 if not found then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 c:=tr8_private.mcp_oauth_parent(parent);
 select * into g from tr8_private.mcp_oauth_grants where id=p_id for update;
 if not found or g.owner_id<>c.owner_id or c.expires_at<=clock_timestamp() or g.revoked_at is not null or g.expires_at<=clock_timestamp()
  or g.parent_fingerprint is distinct from tr8_private.mcp_oauth_fingerprint(c.id)
 then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 perform tr8_private.mcp_oauth_client(g.client_id);
 return g;
end;$$;
create function tr8_private.mcp_oauth_issue(g tr8_private.mcp_oauth_grants,p_scopes text[]) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare a text; r text; expires timestamptz:=least(clock_timestamp()+interval '15 minutes',g.expires_at); begin
 if g.expires_at<=clock_timestamp()+interval '2 seconds' or not p_scopes<@g.scopes then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 -- Expired OAuth families have no surviving authority. Their removal never
 -- touches the permanent financial source/idempotency registry.
 delete from tr8_private.mcp_oauth_grants where owner_id=g.owner_id and expires_at<clock_timestamp()-interval '1 day';
 if (select count(*) from tr8_private.mcp_oauth_access a join tr8_private.mcp_oauth_grants x on x.id=a.grant_id where x.owner_id=g.owner_id)>=10000
  or (select count(*) from tr8_private.mcp_oauth_refresh r join tr8_private.mcp_oauth_grants x on x.id=r.grant_id where x.owner_id=g.owner_id)>=10000
 then perform tr8_private.mcp_oauth_fail('temporarily_unavailable');end if;
 a:='tr8_oauth_a_'||encode(extensions.gen_random_bytes(32),'hex'); r:='tr8_oauth_r_'||encode(extensions.gen_random_bytes(32),'hex');
 insert into tr8_private.mcp_oauth_access values(tr8_private.mcp_oauth_hash(a),g.id,p_scopes,expires,null);
 insert into tr8_private.mcp_oauth_refresh values(tr8_private.mcp_oauth_hash(r),g.id,p_scopes,g.expires_at,null);
 return jsonb_build_object('access_token',a,'refresh_token',r,'token_type','Bearer','expires_in',greatest(0,floor(extract(epoch from expires-clock_timestamp())))::integer,'scope',array_to_string(p_scopes,' '));
end;$$;

create function tr8_private.mcp_oauth_consent(p_action text,p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); sid uuid; a tr8_private.mcp_oauth_attempts; c tr8_private.mcp_credentials;
 client tr8_private.mcp_oauth_clients; g tr8_private.mcp_oauth_grants; parent uuid; result jsonb; raw text;
begin
 perform tr8_private.v2_require_actor(); perform tr8_private.v7_require_browser_session();
 if auth.jwt()?'client_id' then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 sid:=(auth.jwt()->>'session_id')::uuid;
 perform tr8_private.mcp_oauth_require_config();
 if p_input is null or jsonb_typeof(p_input) is distinct from 'object' or octet_length(p_input::text)>16384 then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 if p_action='list' then
  perform tr8_private.mcp_keys(p_input,array[]::text[]);
  return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('grant_id',q.id,'client_id',q.client_id,'client_name',x.client_name,'credential_id',q.credential_id,'scopes',to_jsonb(q.scopes),'created_at',tr8_private.mcp_finance_utc(q.created_at),'expires_at',tr8_private.mcp_finance_utc(q.expires_at),'revoked_at',case when q.revoked_at is not null then tr8_private.mcp_finance_utc(q.revoked_at) end) order by q.created_at desc,q.id)
   from tr8_private.mcp_oauth_grants q join tr8_private.mcp_oauth_clients x on x.client_id=q.client_id where q.owner_id=actor),'[]'::jsonb),'next_cursor',null);
 elsif p_action='revoke' then
  perform tr8_private.mcp_keys(p_input,array['grant_id'],array['grant_id']);
  select * into g from tr8_private.mcp_oauth_grants where id=(p_input->>'grant_id')::uuid and owner_id=actor;
  if not found then raise exception using errcode='PT404',message='OAuth grant unavailable';end if;
  perform tr8_private.v2_lock_workspace((select workspace_id from tr8_private.mcp_credentials where id=g.credential_id));
  perform 1 from tr8_private.mcp_credentials where id=g.credential_id for update;
  update tr8_private.mcp_oauth_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=g.id;
  return jsonb_build_object('grant_id',g.id,'revoked',true);
 end if;
 if p_action='approve' then perform tr8_private.mcp_keys(p_input,array['attempt','credential_id','grant_fingerprint'],array['attempt','credential_id','grant_fingerprint']);
 elsif p_action in ('details','deny') then perform tr8_private.mcp_keys(p_input,array['attempt'],array['attempt']);
 else perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 if jsonb_typeof(p_input->'attempt') is distinct from 'string' or p_input->>'attempt' !~ '^tr8_oauth_p_[a-f0-9]{64}$' then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 if p_action='approve' then
  parent:=(p_input->>'credential_id')::uuid;
  select owner_id into actor from tr8_private.mcp_credentials where id=parent and owner_id=auth.uid();
  if not found then raise exception using errcode='PT404',message='OAuth connection unavailable';end if;
  c:=tr8_private.mcp_oauth_parent(parent);
  perform pg_advisory_xact_lock(hashtextextended('tr8-mcp-oauth-owner:'||actor::text,0));
 end if;
 select * into a from tr8_private.mcp_oauth_attempts where attempt_hash=tr8_private.mcp_oauth_hash(p_input->>'attempt') for update;
 perform tr8_private.v7_require_browser_session();
 if not found or a.status<>'pending' or a.expires_at<=clock_timestamp() then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 client:=tr8_private.mcp_oauth_client(a.client_id);
 -- Static-client administration can block the preceding FOR SHARE lock too.
 -- Do not let that wait turn an expired browser/attempt into a new consent.
 perform tr8_private.v7_require_browser_session();
 if a.expires_at<=clock_timestamp() then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 if a.owner_id is null and p_action='details' then
  update tr8_private.mcp_oauth_attempts set owner_id=actor,session_id=sid where id=a.id;
  a.owner_id:=actor; a.session_id:=sid;
 end if;
 if a.owner_id is distinct from actor or a.session_id is distinct from sid then raise exception using errcode='42501',message='OAuth browser session changed';end if;
 if p_action='details' then
  select jsonb_build_object('attempt',p_input->>'attempt','client_id',client.client_id,'client_name',client.client_name,'redirect_uri',a.redirect_uri,'scopes',to_jsonb(a.scopes),'resource',a.resource,'expires_at',tr8_private.mcp_finance_utc(a.expires_at),
   'connections',coalesce((select jsonb_agg(jsonb_build_object('credential_id',x.id,'name',tr8_private.mcp_finance_safe_text(x.name),'access',f.access,'expires_at',tr8_private.mcp_finance_utc(x.expires_at),'grant_fingerprint',tr8_private.mcp_oauth_fingerprint(x.id),
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('account_id',fa.account_id,'start_at',tr8_private.mcp_finance_utc(fa.start_at),'name',tr8_private.mcp_finance_safe_text(account->>'name'),'currency',account->>'currency') order by fa.account_id)
      from tr8_private.mcp_finance_accounts fa join tr8_private.account_finances l on l.owner_id=actor cross join lateral jsonb_array_elements(l.snapshot#>'{financialSpace,accounts}') account where fa.credential_id=x.id and fa.account_id=account->>'id'),'[]'::jsonb),
    'mailbox_ids',to_jsonb(f.mailbox_ids),'expense_categories',to_jsonb(f.expense_categories),'income_categories',to_jsonb(f.income_categories)) order by x.created_at,x.id)
    from tr8_private.mcp_credentials x join tr8_private.mcp_finance_grants f on f.credential_id=x.id and f.owner_id=actor join tr8_private.workspaces w on w.id=x.workspace_id
    where x.owner_id=actor and x.revoked_at is null and x.expires_at>clock_timestamp() and w.kind='personal' and w.owner_id=actor
     and exists(select 1 from tr8_private.workspace_members m where m.workspace_id=w.id and m.user_id=actor and m.status='active')
     and exists(select 1 from tr8_private.mcp_finance_accounts fa join tr8_private.account_finances l on l.owner_id=actor cross join lateral jsonb_array_elements(l.snapshot#>'{financialSpace,accounts}') account where fa.credential_id=x.id and fa.account_id=account->>'id')
     and (not 'finance:write'=any(a.scopes) or f.access='write')),'[]'::jsonb)) into result;
  return result;
 elsif p_action='deny' then
  perform tr8_private.v7_require_browser_session();
  if a.expires_at<=clock_timestamp() then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
  update tr8_private.mcp_oauth_attempts set status='denied' where id=a.id;
  return jsonb_build_object('redirect_uri',a.redirect_uri,'state',a.state,'error','access_denied');
 end if;
 if 'finance:write'=any(a.scopes) and not exists(select 1 from tr8_private.mcp_finance_grants where credential_id=c.id and access='write') then perform tr8_private.mcp_oauth_fail('invalid_scope');end if;
 if jsonb_typeof(p_input->'grant_fingerprint') is distinct from 'string' or p_input->>'grant_fingerprint' !~ '^[a-f0-9]{64}$' then perform tr8_private.mcp_oauth_fail('invalid_request');end if;
 if p_input->>'grant_fingerprint' is distinct from tr8_private.mcp_oauth_fingerprint(c.id) then raise exception using errcode='PT409',message='Reviewed financial grant changed';end if;
 if c.expires_at<=clock_timestamp() then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 delete from tr8_private.mcp_oauth_grants where owner_id=actor and (expires_at<clock_timestamp()-interval '1 day' or revoked_at<clock_timestamp()-interval '1 day');
 if (select count(*) from tr8_private.mcp_oauth_grants where owner_id=actor)>=100
  or (select count(*) from tr8_private.mcp_oauth_grants where owner_id=actor and revoked_at is null and expires_at>clock_timestamp())>=20 then perform tr8_private.mcp_oauth_fail('temporarily_unavailable');end if;
 perform tr8_private.v7_require_browser_session();
 if a.expires_at<=clock_timestamp() or c.expires_at<=clock_timestamp() then perform tr8_private.mcp_oauth_fail('invalid_grant');end if;
 insert into tr8_private.mcp_oauth_grants(owner_id,credential_id,client_id,scopes,resource,parent_fingerprint,expires_at)
  values(actor,c.id,a.client_id,a.scopes,a.resource,tr8_private.mcp_oauth_fingerprint(c.id),least(c.expires_at,clock_timestamp()+interval '30 days')) returning * into g;
 raw:='tr8_oauth_c_'||encode(extensions.gen_random_bytes(32),'hex');
 insert into tr8_private.mcp_oauth_codes values(tr8_private.mcp_oauth_hash(raw),g.id,a.client_id,a.redirect_uri,a.code_challenge,least(g.expires_at,clock_timestamp()+interval '5 minutes'),null,0);
 update tr8_private.mcp_oauth_attempts set status='approved' where id=a.id;
 return jsonb_build_object('redirect_uri',a.redirect_uri,'state',a.state,'code',raw);
end;$$;

create function tr8_private.mcp_oauth_finance_dispatch(p_token text,p_action text,p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare t tr8_private.mcp_oauth_access; g tr8_private.mcp_oauth_grants; result jsonb;begin
 perform tr8_private.mcp_oauth_require_config();
 if p_token is null or p_token !~ '^tr8_oauth_a_[a-f0-9]{64}$' then raise exception using errcode='PT401',message='Invalid financial OAuth access';end if;
 select * into t from tr8_private.mcp_oauth_access where token_hash=tr8_private.mcp_oauth_hash(p_token);
 if not found then raise exception using errcode='PT401',message='Invalid financial OAuth access';end if;
 g:=tr8_private.mcp_oauth_grant(t.grant_id);
 select * into t from tr8_private.mcp_oauth_access where token_hash=t.token_hash for share;
 if t.revoked_at is not null or t.expires_at<=clock_timestamp() then raise exception using errcode='PT401',message='Invalid financial OAuth access';end if;
 if p_action is null or p_action not in ('finance_context','finance_list_accounts','finance_list_categories','finance_list_movements','finance_submit_notice','finance_list_reviews')
  or (p_action='finance_submit_notice' and not 'finance:write'=any(t.scopes)) then raise exception using errcode='PT403',message='Financial OAuth scope denied';end if;
 -- Obtain the same final owner lock BEFORE checking token expiry and entering
 -- the core. Recheck again after work; expiry while blocked cannot admit a write.
 perform pg_advisory_xact_lock(hashtextextended('tr8-account-finance:'||g.owner_id::text,0));
 if t.expires_at<=clock_timestamp() or g.expires_at<=clock_timestamp() then raise exception using errcode='PT401',message='OAuth access expired while waiting';end if;
 result:=tr8_private.mcp_finance_dispatch_credential(g.credential_id,p_action,p_input);
 if t.expires_at<=clock_timestamp() or g.expires_at<=clock_timestamp() then raise exception using errcode='PT401',message='OAuth access expired before commit';end if;
 if p_action='finance_context' and not result?'_tr8_mcp_error' then
  result:=result||jsonb_build_object('access',case when 'finance:write'=any(t.scopes) then 'write' else 'read' end,'oauth_scopes',to_jsonb(t.scopes));
 end if;
 return result;
exception when others then
 return jsonb_build_object('_tr8_mcp_error',jsonb_build_object('code',case when sqlstate in ('PT403','PT429') then sqlstate when sqlstate='P0001' then 'PT401' else sqlstate end));
end;$$;

revoke all on function tr8_private.mcp_oauth_error(text),tr8_private.mcp_oauth_fail(text),tr8_private.mcp_oauth_hash(text),tr8_private.mcp_oauth_scopes(jsonb),
 tr8_private.mcp_oauth_require_config(),tr8_private.mcp_oauth_client(text),tr8_private.mcp_oauth_parent(uuid),tr8_private.mcp_oauth_fingerprint(uuid),
 tr8_private.mcp_oauth_grant(uuid),tr8_private.mcp_oauth_issue(tr8_private.mcp_oauth_grants,text[]),tr8_private.mcp_oauth_server(text,jsonb),
 tr8_private.mcp_oauth_consent(text,jsonb),tr8_private.mcp_oauth_finance_dispatch(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function tr8_private.mcp_oauth_server(text,jsonb),tr8_private.mcp_oauth_finance_dispatch(text,text,jsonb) to anon,authenticated;
grant execute on function tr8_private.mcp_oauth_consent(text,jsonb) to authenticated;
create function public.tr8_mcp_oauth_server(p_action text,p_input jsonb default '{}'::jsonb) returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.mcp_oauth_server(p_action,p_input);$$;
create function public.tr8_mcp_oauth_consent(p_action text,p_input jsonb default '{}'::jsonb) returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.mcp_oauth_consent(p_action,p_input);$$;
create function public.tr8_mcp_oauth_finance_dispatch(p_token text,p_action text,p_input jsonb default '{}'::jsonb) returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.mcp_oauth_finance_dispatch(p_token,p_action,p_input);$$;
revoke all on function public.tr8_mcp_oauth_server(text,jsonb),public.tr8_mcp_oauth_consent(text,jsonb),public.tr8_mcp_oauth_finance_dispatch(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.tr8_mcp_oauth_server(text,jsonb),public.tr8_mcp_oauth_finance_dispatch(text,text,jsonb) to anon,authenticated;
grant execute on function public.tr8_mcp_oauth_consent(text,jsonb) to authenticated;
notify pgrst,'reload schema';
