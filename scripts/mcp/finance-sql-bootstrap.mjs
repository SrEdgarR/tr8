// Minimal synthetic dependencies for local financial SQL rehearsals only.
export const FINANCE_SQL_BOOTSTRAP = `
create role anon; create role authenticated; create role service_role;
create schema auth; create schema tr8_private; create schema extensions;
create extension pgcrypto with schema extensions;
create table auth.users(id uuid primary key,aud text,role text,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb,raw_user_meta_data jsonb,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz,updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;$$;
create table tr8_private.app_users(user_id uuid primary key references auth.users(id),enabled boolean default true,display_name text default 'Synthetic',calendar_time_zone text default 'America/La_Paz');
create table tr8_private.workspaces(id uuid primary key,owner_id uuid references tr8_private.app_users(user_id),kind text,name text);
create table tr8_private.workspace_authz_state(workspace_id uuid primary key references tr8_private.workspaces(id),version bigint default 0);
create function tr8_private.test_workspace_authz_state() returns trigger language plpgsql as $$begin insert into tr8_private.workspace_authz_state(workspace_id)values(new.id);return new;end;$$;
create trigger test_workspace_authz_state after insert on tr8_private.workspaces for each row execute function tr8_private.test_workspace_authz_state();
create table tr8_private.workspace_members(id uuid primary key default gen_random_uuid(),workspace_id uuid references tr8_private.workspaces(id),user_id uuid references tr8_private.app_users(user_id),status text default 'active');
create table tr8_private.mcp_credentials(id uuid primary key,owner_id uuid references auth.users(id),workspace_id uuid references tr8_private.workspaces(id),name text,access text,token_hash text,created_at timestamptz default clock_timestamp(),expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz,minute_start timestamptz default clock_timestamp(),minute_count integer default 0,day_start date default current_date,day_count integer default 0);
create table tr8_private.account_finances(owner_id uuid primary key references auth.users(id),version bigint,snapshot jsonb,operation_id uuid,updated_at timestamptz default clock_timestamp());
create function tr8_private.v2_user_live(p_user_id uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from auth.users where id=p_user_id and deleted_at is null and email_confirmed_at is not null and (banned_until is null or banned_until<clock_timestamp()));$$;
create function tr8_private.v2_require_actor() returns void language plpgsql security definer set search_path='' as $$begin if not exists(select 1 from tr8_private.app_users where user_id=auth.uid() and enabled) or not tr8_private.v2_user_live(auth.uid()) then raise exception using errcode='42501'; end if; end;$$;
-- Match the production FOR SHARE/FOR UPDATE boundary, not an exclusive advisory
-- substitute that would conceal races between different credentials.
create function tr8_private.v2_lock_workspace(p_workspace_id uuid,p_exclusive boolean default false) returns void language plpgsql volatile security definer set search_path='' as $$begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='This operation requires read committed isolation';end if;
 if p_exclusive then perform 1 from tr8_private.workspace_authz_state where workspace_id=p_workspace_id for update;
 else perform 1 from tr8_private.workspace_authz_state where workspace_id=p_workspace_id for share;end if;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
end;$$;
create function tr8_private.v7_require_browser_session() returns void language plpgsql volatile security definer set search_path='' as $$begin perform 1 from auth.sessions where id=(auth.jwt()->>'session_id')::uuid and user_id=auth.uid() and (not_after is null or not_after>clock_timestamp()) for share; if not found then raise exception using errcode='42501'; end if; end;$$;
create function tr8_private.mcp_keys(p_input jsonb,p_allowed text[],p_required text[] default array[]::text[]) returns void language plpgsql immutable security invoker set search_path='' as $$begin if p_input is null or jsonb_typeof(p_input)<>'object' or exists(select 1 from jsonb_object_keys(p_input)k where not k=any(p_allowed)) or not p_input?&p_required then raise exception using errcode='22023'; end if; end;$$;
grant usage on schema public,auth,tr8_private to anon,authenticated;
grant execute on function auth.uid(),auth.jwt() to anon,authenticated;
revoke all on all tables in schema auth,tr8_private from public,anon,authenticated;
`;
