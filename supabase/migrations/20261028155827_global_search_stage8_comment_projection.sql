-- Preserve the task priority only on task results; comments expose their task status.
begin;
create or replace function tr8_private.global_search(w uuid,i jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare actor uuid:=auth.uid();q text;k text;include_old boolean;off integer;lim integer;
 actor_member uuid;owner uuid;tasks_allowed boolean;directory_allowed boolean;ws_kind text;outcome jsonb;
begin
 perform tr8_private.v7_require_browser_session();
 perform tr8_private.v2_require_workspace(w,'project.read');
 select m.id into actor_member from tr8_private.workspace_members m where m.workspace_id=w and m.user_id=actor and m.status='active';
 if actor_member is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if i is null or jsonb_typeof(i)<>'object' or octet_length(i::text)>4096
 then raise exception using errcode='22023',message='Invalid search input';end if;
 perform tr8_private.productivity_keys(i,array['query','kind','include_archived','offset','limit']);
 if jsonb_typeof(i->'query') is distinct from 'string' or jsonb_typeof(i->'kind') is distinct from 'string'
  or jsonb_typeof(i->'include_archived') is distinct from 'boolean' or jsonb_typeof(i->'offset') is distinct from 'number'
  or jsonb_typeof(i->'limit') is distinct from 'number'
 then raise exception using errcode='22023',message='Invalid search fields';end if;
 q:=i->>'query';k:=i->>'kind';include_old:=(i->>'include_archived')::boolean;
 if q<>btrim(q) or length(q) not between 2 and 100 or q~'^[[:space:]]*$'
  or exists(select 1 from generate_series(1,length(q))p where ascii(substring(q from p for 1)) between 1 and 31 or ascii(substring(q from p for 1)) between 127 and 159)
  or k<>all(array['all','project','task','member','file','comment'])
  or i->>'offset'!~'^(0|[1-9][0-9]{0,4})$' or i->>'limit'!~'^[1-9][0-9]?$'
 then raise exception using errcode='22023',message='Invalid search query or page';end if;
 off:=(i->>'offset')::integer;lim:=(i->>'limit')::integer;
 if off>10000 or lim>50 or (k='all' and off<>0)
 then raise exception using errcode='22023',message='Search page outside supported bounds';end if;
 select owner_id,kind into owner,ws_kind from tr8_private.workspaces where id=w;
 tasks_allowed:=tr8_private.v2_has_permission(w,'task.read');
 directory_allowed:=ws_kind='team' and tr8_private.v2_has_permission(w,'member.read');
 -- Materialize the authorized project set once. Authorization mutations share
 -- the workspace serialization protocol held by v2_require_workspace above.
 -- Workspace/project indexes bound each source; no per-result identity lookup
 -- exposes rows that do not belong to this project's currently readable set.
 with projects as materialized(
  select p.* from public.tr8_workspace_projects p
  where p.workspace_id=w and (include_old or p.archived_at is null)
   and (owner=actor or exists(select 1 from tr8_private.project_access a
    where a.workspace_id=w and a.project_id=p.id and a.member_id=actor_member))
 ), tasks as materialized(
  select t.* from public.tr8_workspace_tasks t join projects p on p.id=t.project_id and p.workspace_id=t.workspace_id
  where t.workspace_id=w and tasks_allowed and (include_old or t.archived_at is null)
 ), matches as materialized(
  select p.id,'project'::text kind,1 kind_order,p.id project_id,null::uuid task_id,p.name title,
   tr8_private.search_excerpt(p.description,q) snippet,p.name project_name,p.color project_color,p.icon project_icon,
   p.status,null::text priority,null::text content_type,null::uuid member_id,null::uuid author_id,p.updated_at,p.archived_at is not null archived
  from projects p where strpos(lower(p.name),lower(q))>0 or strpos(lower(p.code),lower(q))>0 or strpos(lower(p.description),lower(q))>0
  union all
  select t.id,'task',2,p.id,t.id,t.title,tr8_private.search_excerpt(t.description,q),p.name,p.color,p.icon,
   t.status,t.priority,null,null,null,t.updated_at,t.archived_at is not null or p.archived_at is not null
  from tasks t join projects p on p.id=t.project_id
  where strpos(lower(t.title),lower(q))>0 or strpos(lower(t.description),lower(q))>0 or strpos(lower(p.code||'-'||t.task_number::text),lower(q))>0
  union all
  select m.id,'member',3,null,null,u.display_name,'Miembro del equipo',null,null,null,
   'active',null,null,m.id,null,greatest(m.updated_at,u.updated_at),false
  from tr8_private.workspace_members m join tr8_private.app_users u on u.user_id=m.user_id
  where m.workspace_id=w and directory_allowed and m.status='active' and u.enabled and tr8_private.v2_user_live(m.user_id)
   and strpos(lower(u.display_name),lower(q))>0
  union all
  select f.id,'file',4,p.id,null,f.name,'',p.name,p.color,p.icon,
   'ready',null,f.content_type,null,null,f.created_at,p.archived_at is not null
  from tr8_private.project_files f join projects p on p.workspace_id=f.workspace_id and p.id=f.project_id
  where f.workspace_id=w and f.status='ready' and strpos(lower(f.name),lower(q))>0
  union all
  select c.id,'comment',5,p.id,t.id,t.title,tr8_private.search_excerpt(c.body,q),p.name,p.color,p.icon,
   t.status,null,null,null,c.author_id,c.updated_at,t.archived_at is not null or p.archived_at is not null
  from tr8_private.task_comments c join tasks t on t.workspace_id=c.workspace_id and t.id=c.task_id join projects p on p.id=t.project_id
  where c.workspace_id=w and (strpos(lower(c.body),lower(q))>0 or strpos(lower(t.title),lower(q))>0)
 ), numbered as(
  select m.*,row_number() over(partition by kind order by updated_at desc,id desc) ordinal from matches m
 ), counts as(
  select jsonb_build_object('project',count(*) filter(where kind='project'),'task',count(*) filter(where kind='task'),
   'member',count(*) filter(where kind='member'),'file',count(*) filter(where kind='file'),'comment',count(*) filter(where kind='comment')) counts,
   count(*) filter(where kind=k) selected_count from matches
 ), page as(
  select n.* from numbered n where (k='all' and ordinal<=lim) or (kind=k and ordinal>off and ordinal<=off+lim)
 )
 select jsonb_build_object('workspace_id',w,'query',q,'kind',k,'include_archived',include_old,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'workspace_id',w,'project_id',p.project_id,'task_id',p.task_id,
   'title',p.title,'snippet',p.snippet,'project_name',p.project_name,'project_color',p.project_color,'project_icon',p.project_icon,
   'status',p.status,'priority',p.priority,'content_type',p.content_type,'member_id',p.member_id,
   'author_name',case when p.author_id is not null then tr8_private.communication_name(w,p.author_id) else null end,
   'updated_at',p.updated_at,'archived',p.archived) order by p.kind_order,p.updated_at desc,p.id desc) from page p),'[]'::jsonb),
  'counts',counts.counts,'next_offset',case when k<>'all' and off+lim<counts.selected_count and off+lim<=10000 then off+lim else null end)
 into outcome from counts;
 return outcome;
end;$$;
revoke all on function tr8_private.global_search(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function tr8_private.global_search(uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
