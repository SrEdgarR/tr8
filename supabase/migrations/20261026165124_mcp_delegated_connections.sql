-- Delegated TR8 business access. No finance, administrative or delete surface.
-- Bearer credentials are independently revocable and can never select an actor
-- or workspace supplied by the caller. Existing v2/v3 commands remain the
-- authorization, concurrency, Google synchronization and activity boundary.
create table tr8_private.mcp_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references tr8_private.app_users(user_id) on delete restrict,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete restrict,
  name text not null check(length(btrim(name)) between 1 and 80),
  access text not null check(access in ('read','write')),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  minute_start timestamptz not null default statement_timestamp(),
  minute_count integer not null default 0 check(minute_count>=0),
  day_start date not null default current_date,
  day_count integer not null default 0 check(day_count>=0),
  check(expires_at>created_at and expires_at<=created_at+interval '90 days')
);
create index mcp_credentials_owner on tr8_private.mcp_credentials(owner_id,created_at desc);
create table tr8_private.mcp_activity (
  id bigint generated always as identity primary key,
  credential_id uuid not null references tr8_private.mcp_credentials(id) on delete cascade,
  action text not null check(action in ('create_project','update_project','create_task','update_task','schedule_task')),
  resource_id uuid not null,
  created_at timestamptz not null default statement_timestamp()
);
create index mcp_activity_credential on tr8_private.mcp_activity(credential_id,id desc);
alter table tr8_private.mcp_credentials enable row level security;
alter table tr8_private.mcp_activity enable row level security;
revoke all on tr8_private.mcp_credentials,tr8_private.mcp_activity from public,anon,authenticated;
revoke all on sequence tr8_private.mcp_activity_id_seq from public,anon,authenticated;

create function tr8_private.mcp_keys(p_input jsonb,p_allowed text[],p_required text[] default array[]::text[])
returns void language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_input is null or jsonb_typeof(p_input)<>'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where not k=any(p_allowed))
    or not p_input ?& p_required then
    raise exception using errcode='22023',message='Invalid MCP arguments';
  end if;
end;
$$;
create function tr8_private.mcp_credential_json(p_row tr8_private.mcp_credentials)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',p_row.id,'name',p_row.name,'workspace_id',p_row.workspace_id,
    'access',p_row.access,'created_at',p_row.created_at,'expires_at',p_row.expires_at,
    'revoked_at',p_row.revoked_at,'last_used_at',p_row.last_used_at);
$$;

create function tr8_private.mcp_manage(p_action text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row tr8_private.mcp_credentials; v_token text; v_days integer; v_workspace uuid;
begin
  perform tr8_private.v2_require_actor();
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

create function tr8_private.mcp_dispatch(p_token text,p_action text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_row tr8_private.mcp_credentials; v_workspace uuid; v_hash text; v_result jsonb; v_patch jsonb;
  v_old_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
  v_old_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
  v_old_role text:=coalesce(current_setting('request.jwt.claim.role',true),'');
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
  if p_action is null or p_action<>all(array['context','list_projects','get_project','list_tasks','get_task','calendar',
      'create_project','update_project','create_task','update_task','schedule_task']) then
    raise exception using errcode='22023',message='Unknown MCP action';
  end if;
  if v_write and v_row.access<>'write' then raise exception using errcode='PT403',message='Connection is read only'; end if;
  if (v_row.minute_start>clock_timestamp()-interval '1 minute' and v_row.minute_count>=60)
    or (v_row.day_start=current_date and v_row.day_count>=1000) then
    raise exception using errcode='PT429',message='MCP request limit reached';
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_row.owner_id,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',v_row.owner_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
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
    update tr8_private.mcp_credentials set last_used_at=clock_timestamp(),
      minute_count=case when minute_start<=clock_timestamp()-interval '1 minute' then 1 else minute_count+1 end,
      minute_start=case when minute_start<=clock_timestamp()-interval '1 minute' then clock_timestamp() else minute_start end,
      day_count=case when day_start<>current_date then 1 else day_count+1 end,day_start=current_date where id=v_row.id;
  exception when others then
    perform set_config('request.jwt.claims',v_old_claims,true);
    perform set_config('request.jwt.claim.sub',v_old_sub,true);
    perform set_config('request.jwt.claim.role',v_old_role,true);
    raise;
  end;
  perform set_config('request.jwt.claims',v_old_claims,true);
  perform set_config('request.jwt.claim.sub',v_old_sub,true);
  perform set_config('request.jwt.claim.role',v_old_role,true);
  return v_result;
end;
$$;

revoke all on function tr8_private.mcp_keys(jsonb,text[],text[]),tr8_private.mcp_credential_json(tr8_private.mcp_credentials),
  tr8_private.mcp_manage(text,jsonb),tr8_private.mcp_dispatch(text,text,jsonb) from public,anon,authenticated;
grant usage on schema tr8_private to anon,authenticated;
grant execute on function tr8_private.mcp_manage(text,jsonb) to authenticated;
grant execute on function tr8_private.mcp_dispatch(text,text,jsonb) to anon,authenticated;
create function public.tr8_mcp_credentials(p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.mcp_manage(p_action,p_input);$$;
create function public.tr8_mcp_dispatch(p_token text,p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.mcp_dispatch(p_token,p_action,p_input);$$;
revoke all on function public.tr8_mcp_credentials(text,jsonb),public.tr8_mcp_dispatch(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.tr8_mcp_credentials(text,jsonb) to authenticated;
grant execute on function public.tr8_mcp_dispatch(text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
