-- Security audit: deny replay of terminated browser sessions, prevent a stale
-- JWT from minting durable MCP access, and charge failed delegated commands.
-- Existing data, grants and function identities remain unchanged.
create function tr8_private.v7_actor_session_live()
returns boolean language plpgsql stable security definer set search_path='' as $$
declare a uuid:=auth.uid(); s uuid; c uuid; h text;
begin
  if a is null then return false; end if;
  if auth.jwt()->>'session_id' is not null then
    begin s:=(auth.jwt()->>'session_id')::uuid; exception when others then return false; end;
    return exists(select 1 from auth.sessions where id=s and user_id=a
      and (not_after is null or not_after>statement_timestamp()));
  end if;
  -- These transaction-local markers are set only by mcp_dispatch after checking
  -- the opaque key. Neither request arguments nor signed-in users can set them.
  begin c:=nullif(current_setting('tr8.mcp_credential_id',true),'')::uuid;
  exception when others then return false; end;
  h:=current_setting('tr8.mcp_token_hash',true);
  return c is not null and h is not null and exists(
    select 1 from tr8_private.mcp_credentials where id=c and owner_id=a
      and token_hash=h and revoked_at is null and expires_at>statement_timestamp());
end;
$$;
revoke all on function tr8_private.v7_actor_session_live() from public,anon,authenticated,service_role;

create function tr8_private.v7_require_browser_session()
returns void language plpgsql volatile security definer set search_path='' as $$
declare a uuid:=auth.uid(); s uuid;
begin
  begin s:=(auth.jwt()->>'session_id')::uuid;
  exception when others then raise exception using errcode='42501',message='This account session is not authorized'; end;
  if a is null or s is null or not tr8_private.v2_user_live(a) then
    raise exception using errcode='42501',message='This account session is not authorized';
  end if;
  perform 1 from auth.sessions where id=s and user_id=a
    and (not_after is null or not_after>clock_timestamp()) for share;
  if not found then raise exception using errcode='42501',message='This account session is not authorized'; end if;
end;
$$;
revoke all on function tr8_private.v7_require_browser_session() from public,anon,authenticated,service_role;

create or replace function tr8_private.v2_actor_enabled()
returns boolean language sql stable security definer set search_path='' as $$
  select (select auth.uid()) is not null
    and tr8_private.v2_user_live((select auth.uid()))
    and exists(select 1 from tr8_private.app_users a where a.user_id=(select auth.uid()) and a.enabled)
    and tr8_private.v7_actor_session_live();
$$;

create or replace function tr8_private.mcp_manage(p_action text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row tr8_private.mcp_credentials; v_token text; v_days integer; v_workspace uuid;
begin
  perform tr8_private.v2_require_actor();
  perform tr8_private.v7_require_browser_session();
  if p_action='list' then
    perform tr8_private.mcp_keys(p_input,array[]::text[]);
    return coalesce((select jsonb_agg(tr8_private.mcp_credential_json(c) order by c.created_at desc,c.id)
      from tr8_private.mcp_credentials c where c.owner_id=auth.uid()),'[]'::jsonb);
  elsif p_action='revoke' then
    perform tr8_private.mcp_keys(p_input,array['id'],array['id']);
    update tr8_private.mcp_credentials set revoked_at=coalesce(revoked_at,clock_timestamp())
      where id=(p_input->>'id')::uuid and owner_id=auth.uid() returning * into v_row;
    if not found then raise exception using errcode='PT404',message='Connection unavailable'; end if;
    return tr8_private.mcp_credential_json(v_row);
  elsif p_action='create' then
    perform tr8_private.mcp_keys(p_input,array['name','workspace_id','access','expires_in_days'],array['name','workspace_id','access','expires_in_days']);
    if jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 80
      or p_input->>'access' not in ('read','write') or jsonb_typeof(p_input->'expires_in_days')<>'number'
      or (p_input->>'expires_in_days')!~'^[0-9]+$' then
      raise exception using errcode='22023',message='Invalid connection settings';
    end if;
    v_days:=(p_input->>'expires_in_days')::integer;
    if v_days not between 1 and 90 then raise exception using errcode='22023',message='Expiry must be between 1 and 90 days'; end if;
    v_workspace:=(p_input->>'workspace_id')::uuid;
    perform tr8_private.v2_require_workspace(v_workspace,'project.read');
    if not exists(select 1 from tr8_private.workspace_members m where m.workspace_id=v_workspace and m.user_id=auth.uid() and m.status='active') then
      raise exception using errcode='PT404',message='Workspace unavailable';
    end if;
    -- Serialize token creation per owner; retain only a bounded recent history.
    perform 1 from tr8_private.app_users a where a.user_id=auth.uid() for update;
    delete from tr8_private.mcp_credentials where owner_id=auth.uid() and expires_at<statement_timestamp()-interval '30 days';
    if (select count(*) from tr8_private.mcp_credentials where owner_id=auth.uid())>=100
      or (select count(*) from tr8_private.mcp_credentials where owner_id=auth.uid() and revoked_at is null and expires_at>clock_timestamp())>=20 then
      raise exception using errcode='PT429',message='Connection limit reached';
    end if;
    v_token:='tr8_mcp_'||encode(extensions.gen_random_bytes(32),'hex');
    insert into tr8_private.mcp_credentials(owner_id,workspace_id,name,access,token_hash,expires_at)
      values(auth.uid(),v_workspace,btrim(p_input->>'name'),p_input->>'access',
        encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex'),statement_timestamp()+make_interval(days=>v_days)) returning * into v_row;
    return tr8_private.mcp_credential_json(v_row)||jsonb_build_object('token',v_token);
  end if;
  raise exception using errcode='22023',message='Unknown connection action';
end;
$$;

create or replace function tr8_private.mcp_dispatch(p_token text,p_action text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_row tr8_private.mcp_credentials; v_workspace uuid; v_hash text; v_result jsonb; v_patch jsonb;
  v_old_claim text:=coalesce(current_setting('request.jwt.claim',true),'');
  v_old_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
  v_old_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
  v_old_role text:=coalesce(current_setting('request.jwt.claim.role',true),'');
  v_old_mcp_id text:=coalesce(current_setting('tr8.mcp_credential_id',true),'');
  v_old_mcp_hash text:=coalesce(current_setting('tr8.mcp_token_hash',true),'');
  v_limit integer; v_ids uuid[]; v_calendar_projects uuid[]; v_cursor uuid; v_project uuid; v_task public.tr8_workspace_tasks;
  v_write boolean:=p_action=any(array['create_project','update_project','create_task','update_task','schedule_task']);
begin
  if p_token is null or p_token!~'^tr8_mcp_[a-f0-9]{64}$' then
    raise exception using errcode='PT401',message='Invalid MCP credential';
  end if;
  v_hash:=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  select workspace_id into v_workspace from tr8_private.mcp_credentials c where c.token_hash=v_hash;
  if not found then raise exception using errcode='PT401',message='Invalid MCP credential'; end if;
  -- Shared workspace lock precedes credential lock and all business row locks.
  -- Revocation UPDATE serializes with every active dispatch transaction.
  perform tr8_private.v2_lock_workspace(v_workspace);
  select * into v_row from tr8_private.mcp_credentials c where c.token_hash=v_hash for update;
  if not found or v_row.revoked_at is not null or v_row.expires_at<=clock_timestamp() then
    raise exception using errcode='PT401',message='Invalid MCP credential';
  end if;
  if (v_row.minute_start>clock_timestamp()-interval '1 minute' and v_row.minute_count>=60)
    or (v_row.day_start=current_date and v_row.day_count>=1000) then
    raise exception using errcode='PT429',message='MCP request limit reached';
  end if;
  -- Persist one reservation even when the command fails inside its savepoint.
  update tr8_private.mcp_credentials set last_used_at=clock_timestamp(),
        minute_count=case when minute_start<=clock_timestamp()-interval '1 minute' then 1 else minute_count+1 end,
        minute_start=case when minute_start<=clock_timestamp()-interval '1 minute' then clock_timestamp() else minute_start end,
        day_count=case when day_start<>current_date then 1 else day_count+1 end,day_start=current_date where id=v_row.id;
  perform set_config('tr8.mcp_credential_id',v_row.id::text,true);
  perform set_config('tr8.mcp_token_hash',v_row.token_hash,true);
  perform set_config('request.jwt.claim',jsonb_build_object('sub',v_row.owner_id,'role','authenticated')::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_row.owner_id,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_row.owner_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    if p_action is null or p_action<>all(array['context','list_projects','get_project','list_tasks','get_task','calendar',
        'create_project','update_project','create_task','update_task','schedule_task']) then
      raise exception using errcode='22023',message='Unknown MCP action';
    end if;
    if v_write and v_row.access<>'write' then raise exception using errcode='PT403',message='Connection is read only'; end if;
    if p_input is null or octet_length(p_input::text)>262144 then
      raise exception using errcode='22023',message='MCP arguments exceed the allowed size';
    end if;
    if not tr8_private.v2_actor_enabled() or not exists(select 1 from tr8_private.workspace_members m
      where m.workspace_id=v_workspace and m.user_id=v_row.owner_id and m.status='active') then
      raise exception using errcode='PT401',message='Connection owner is unavailable';
    end if;
    perform tr8_private.v2_require_workspace(v_workspace,'project.read');
    case p_action
      when 'context' then
        perform tr8_private.mcp_keys(p_input,array[]::text[]);
        select jsonb_build_object('workspace',jsonb_build_object('id',w.id,'name',w.name,'kind',w.kind),
          'access',v_row.access,'time_zone',a.calendar_time_zone,'scopes',
          (select coalesce(jsonb_agg(s.scope),'[]'::jsonb) from (values
            ('projects:read',true),
            ('tasks:read',tr8_private.v2_has_permission(v_workspace,'task.read')),
            ('calendar:read',tr8_private.v2_has_permission(v_workspace,'task.read')),
            ('projects:write',v_row.access='write' and (tr8_private.v2_has_permission(v_workspace,'project.create') or tr8_private.v2_has_permission(v_workspace,'project.edit'))),
            ('tasks:write',v_row.access='write' and tr8_private.v2_has_permission(v_workspace,'task.read') and (tr8_private.v2_has_permission(v_workspace,'task.create') or tr8_private.v2_has_permission(v_workspace,'task.edit') or tr8_private.v2_has_permission(v_workspace,'task.assign')))
          ) s(scope,allowed) where s.allowed)) into v_result
          from tr8_private.workspaces w join tr8_private.app_users a on a.user_id=v_row.owner_id where w.id=v_workspace;
      when 'list_projects' then
        perform tr8_private.mcp_keys(p_input,array['cursor','limit','include_archived']);
        v_limit:=coalesce((p_input->>'limit')::integer,50); v_cursor:=(p_input->>'cursor')::uuid;
        if v_limit not between 1 and 100 then raise exception using errcode='22023',message='Invalid page size'; end if;
        select array_agg(id order by id) into v_ids from (select p.id from public.tr8_workspace_projects p
          where p.workspace_id=v_workspace and (v_cursor is null or p.id>v_cursor)
            and (coalesce((p_input->>'include_archived')::boolean,false) or p.archived_at is null)
            and tr8_private.v2_can_read_project(v_workspace,p.id) order by p.id limit v_limit+1) q;
        select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb),
          'next_cursor',case when cardinality(v_ids)>v_limit then v_ids[v_limit]::text else null end) into v_result
          from public.tr8_workspace_projects p where p.workspace_id=v_workspace and p.id=any(v_ids[1:v_limit]);
      when 'get_project' then
        perform tr8_private.mcp_keys(p_input,array['id'],array['id']);
        v_project:=(p_input->>'id')::uuid;
        perform tr8_private.v2_require_project(v_workspace,v_project,'project.read',false);
        select to_jsonb(p) into v_result from public.tr8_workspace_projects p where p.workspace_id=v_workspace and p.id=v_project;
      when 'list_tasks' then
        perform tr8_private.mcp_keys(p_input,array['project_id','cursor','limit','status','query']);
        perform tr8_private.v2_require_workspace(v_workspace,'task.read');
        v_limit:=coalesce((p_input->>'limit')::integer,50); v_cursor:=(p_input->>'cursor')::uuid; v_project:=(p_input->>'project_id')::uuid;
        if v_limit not between 1 and 100 or length(coalesce(p_input->>'query',''))>200 then raise exception using errcode='22023',message='Invalid task filters'; end if;
        if p_input ? 'status' and p_input->>'status'<>all(array['backlog','todo','progress','review','done']) then raise exception using errcode='22023',message='Invalid task status'; end if;
        if v_project is not null then perform tr8_private.v2_require_project(v_workspace,v_project,'task.read',false); end if;
        select array_agg(id order by id) into v_ids from (select t.id from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.id=t.project_id and p.workspace_id=t.workspace_id
          where t.workspace_id=v_workspace and p.archived_at is null and (v_cursor is null or t.id>v_cursor)
            and (v_project is null or t.project_id=v_project) and (not p_input?'status' or t.status=p_input->>'status')
            and (not p_input?'query' or strpos(lower(t.title),lower(p_input->>'query'))>0)
            and tr8_private.v2_can_read_project(v_workspace,t.project_id) order by t.id limit v_limit+1) q;
        select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb),
          'next_cursor',case when cardinality(v_ids)>v_limit then v_ids[v_limit]::text else null end) into v_result
          from public.tr8_workspace_tasks t where t.workspace_id=v_workspace and t.id=any(v_ids[1:v_limit]);
      when 'get_task' then
        perform tr8_private.mcp_keys(p_input,array['id'],array['id']);
        select * into v_task from public.tr8_workspace_tasks t where t.workspace_id=v_workspace and t.id=(p_input->>'id')::uuid;
        if not found then raise exception using errcode='PT404',message='Task unavailable'; end if;
        perform tr8_private.v2_require_project(v_workspace,v_task.project_id,'task.read',false);
        v_result:=to_jsonb(v_task);
      when 'calendar' then
        perform tr8_private.mcp_keys(p_input,array['date_from','date_to','time_zone','project_ids','cursor','limit'],array['date_from','date_to','time_zone']);
        v_limit:=coalesce((p_input->>'limit')::integer,50);
        if v_limit not between 1 and 100 then raise exception using errcode='22023',message='Invalid page size'; end if;
        if p_input?'project_ids' then
          if jsonb_typeof(p_input->'project_ids')<>'array' or jsonb_array_length(p_input->'project_ids')>250 then
            raise exception using errcode='22023',message='Invalid project filters';
          end if;
          v_calendar_projects:=array(select value::uuid from jsonb_array_elements_text(p_input->'project_ids'));
          foreach v_project in array v_calendar_projects loop
            perform tr8_private.v2_require_project(v_workspace,v_project,'task.read',false);
          end loop;
        end if;
        v_result:=tr8_private.v3_list_calendar(array[v_workspace],(p_input->>'date_from')::date,(p_input->>'date_to')::date,p_input->>'time_zone',
          v_calendar_projects,
          null,null,false,false,p_input->>'cursor',v_limit);
      when 'create_project' then
        perform tr8_private.mcp_keys(p_input,array['request_id','name','description','color','status'],array['request_id','name']);
        v_result:=to_jsonb(tr8_private.v2_create_project(v_workspace,(p_input->>'request_id')::uuid,p_input->>'name',
          coalesce(p_input->>'description',''),coalesce(p_input->>'color','#8B8CF8'),coalesce(p_input->>'status','active')));
      when 'update_project' then
        perform tr8_private.mcp_keys(p_input,array['id','version','patch'],array['id','version','patch']);
        perform tr8_private.mcp_keys(p_input->'patch',array['name','description','color','status']);
        v_result:=to_jsonb(tr8_private.v2_update_project(v_workspace,(p_input->>'id')::uuid,(p_input->>'version')::integer,p_input->'patch'));
      when 'create_task' then
        perform tr8_private.mcp_keys(p_input,array['request_id','project_id','title','description','status','priority','start_date','due_date'],array['request_id','project_id','title']);
        v_result:=to_jsonb(tr8_private.v2_create_task(v_workspace,(p_input->>'request_id')::uuid,(p_input->>'project_id')::uuid,p_input->>'title',
          coalesce(p_input->>'description',''),coalesce(p_input->>'status','todo'),coalesce(p_input->>'priority','none'),
          (p_input->>'start_date')::date,(p_input->>'due_date')::date));
      when 'update_task' then
        perform tr8_private.mcp_keys(p_input,array['id','version','patch'],array['id','version','patch']);
        v_patch:=p_input->'patch';
        perform tr8_private.mcp_keys(v_patch,array['title','description','status','priority','start_date','due_date','assignee_member_id']);
        if v_patch='{}'::jsonb then raise exception using errcode='22023',message='A task patch is required'; end if;
        if (v_patch-'assignee_member_id')<>'{}'::jsonb then
          v_task:=tr8_private.v2_update_task(v_workspace,(p_input->>'id')::uuid,(p_input->>'version')::integer,v_patch-'assignee_member_id');
        end if;
        if v_patch?'assignee_member_id' then
          v_task:=tr8_private.v2_assign_task(v_workspace,(p_input->>'id')::uuid,
            case when (v_patch-'assignee_member_id')<>'{}'::jsonb then v_task.version else (p_input->>'version')::integer end,
            (v_patch->>'assignee_member_id')::uuid);
        end if;
        v_result:=to_jsonb(v_task);
      when 'schedule_task' then
        perform tr8_private.mcp_keys(p_input,array['id','version','scheduled_start_at','scheduled_end_at','scheduled_time_zone'],array['id','version','scheduled_start_at','scheduled_end_at','scheduled_time_zone']);
        v_result:=to_jsonb(tr8_private.v3_schedule_task(v_workspace,(p_input->>'id')::uuid,(p_input->>'version')::integer,
          p_input->>'scheduled_start_at',p_input->>'scheduled_end_at',p_input->>'scheduled_time_zone'));
    end case;
    if v_result is null then raise exception using errcode='PT404',message='Resource unavailable'; end if;
    if v_write then
      insert into tr8_private.mcp_activity(credential_id,action,resource_id) values(v_row.id,p_action,(v_result->>'id')::uuid);
      delete from tr8_private.mcp_activity where credential_id=v_row.id and id in
        (select id from tr8_private.mcp_activity where credential_id=v_row.id order by id desc offset 1000);
    end if;

  exception when others then
    perform set_config('request.jwt.claim',v_old_claim,true);
    perform set_config('request.jwt.claims',v_old_claims,true);
    perform set_config('request.jwt.claim.sub',v_old_sub,true);
    perform set_config('request.jwt.claim.role',v_old_role,true);
    perform set_config('tr8.mcp_credential_id',v_old_mcp_id,true);
    perform set_config('tr8.mcp_token_hash',v_old_mcp_hash,true);
    -- Returning a closed error envelope commits only the quota reservation.
    -- Changes in the command's savepoint, including audit/outbox, roll back.
    return jsonb_build_object('_tr8_mcp_error',jsonb_build_object('code',sqlstate));
  end;
  perform set_config('request.jwt.claim',v_old_claim,true);
  perform set_config('request.jwt.claims',v_old_claims,true);
  perform set_config('request.jwt.claim.sub',v_old_sub,true);
  perform set_config('request.jwt.claim.role',v_old_role,true);
  perform set_config('tr8.mcp_credential_id',v_old_mcp_id,true);
  perform set_config('tr8.mcp_token_hash',v_old_mcp_hash,true);
  return v_result;
end;
$$;


create or replace function tr8_private.v2_accept_invitation(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_workspace uuid; v_hash text; v_row tr8_private.invitations; v_email text; v_member uuid; v_permissions text[];
begin
  perform tr8_private.v2_require_invitations_enabled();
  perform tr8_private.v7_require_browser_session();
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '25000', message = 'This operation requires read committed isolation';
  end if;
  if auth.uid() is null or not tr8_private.v2_user_live(auth.uid()) or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  -- Discover scope without a row lock, then obey workspace -> invitation order.
  select i.workspace_id into v_workspace from tr8_private.invitations i where i.token_hash = v_hash;
  if not found then raise exception using errcode = '42501', message = 'Invitation unavailable'; end if;
  perform tr8_private.v2_lock_workspace(v_workspace, true);
  perform tr8_private.v2_require_invitations_enabled();
  if not tr8_private.v2_user_live(auth.uid()) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  select * into v_row from tr8_private.invitations i where i.token_hash = v_hash for update;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid()
    and u.email_confirmed_at is not null and u.deleted_at is null;
  if v_row.email is distinct from v_email then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  if v_row.status = 'accepted' then
    if v_row.accepted_by <> auth.uid() or not tr8_private.v2_actor_enabled() then
      raise exception using errcode = '42501', message = 'Invitation unavailable';
    end if;
    select m.id into v_member from tr8_private.workspace_members m
      where m.workspace_id = v_workspace and m.user_id = auth.uid() and m.status = 'active';
    if not found then raise exception using errcode = '42501', message = 'Invitation unavailable'; end if;
    return jsonb_build_object('workspace_id', v_workspace, 'member_id', v_member, 'status', 'accepted');
  end if;
  if v_row.status <> 'pending' or v_row.expires_at <= statement_timestamp()
    or not tr8_private.v2_user_live(v_row.invited_by)
    or not exists(select 1 from tr8_private.workspaces w where w.id = v_workspace and w.kind = 'team' and w.owner_id = v_row.invited_by) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  v_permissions := tr8_private.v2_permissions_for(v_workspace, v_row.invited_by);
  if not ('member.invite' = any(v_permissions)) or exists(
    select 1 from tr8_private.role_permissions rp where rp.workspace_id = v_workspace and rp.role_id = v_row.role_id
      and not (rp.permission = any(v_permissions))) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  -- Existing administratively disabled accounts are never re-enabled by a token.
  if exists(select 1 from tr8_private.app_users a where a.user_id = auth.uid() and not a.enabled) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  insert into tr8_private.app_users(user_id) values(auth.uid()) on conflict(user_id) do nothing;
  perform tr8_private.v2_ensure_personal(auth.uid());
  select m.id into v_member from tr8_private.workspace_members m
    where m.workspace_id = v_workspace and m.user_id = auth.uid() for update;
  if found then
    if exists(select 1 from tr8_private.workspace_members m where m.id = v_member and m.status <> 'active') then
      -- Stage 2 owns explicit member reinstatement and its previous role/ACL cleanup.
      raise exception using errcode = '42501', message = 'Invitation unavailable';
    end if;
  else
    insert into tr8_private.workspace_members(workspace_id, user_id) values(v_workspace, auth.uid()) returning id into v_member;
  end if;
  insert into tr8_private.member_roles(workspace_id, member_id, role_id)
    values(v_workspace, v_member, v_row.role_id) on conflict do nothing;
  update tr8_private.invitations set status = 'accepted', accepted_by = auth.uid(), accepted_at = statement_timestamp(),
    version = version + 1, updated_at = statement_timestamp() where id = v_row.id;
  update tr8_private.workspace_authz_state set version = version + 1 where workspace_id = v_workspace;
  insert into tr8_private.workspace_activity(workspace_id, actor_id, action, resource_id)
    values(v_workspace, auth.uid(), 'invitation.accepted', v_row.id);
  return jsonb_build_object('workspace_id', v_workspace, 'member_id', v_member, 'status', 'accepted');
end;
$$;
