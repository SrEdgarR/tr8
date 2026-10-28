-- Demo parity stage 7: real task conversations and private in-app notifications.
-- No external delivery, account provisioning, financial or provider changes.
begin;
lock table public.tr8_workspace_projects,public.tr8_workspace_tasks,tr8_private.account_finances,tr8_private.app_config in share row exclusive mode;
create temporary table tr8_communication_before on commit drop as select
 (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p) projects,
 (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t) tasks,
 (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f) finances,
 (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c) config;

create table tr8_private.task_comments (
 id uuid primary key,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 task_id uuid not null,
 author_id uuid not null,
 body text not null check(length(body) between 1 and 4000 and body=btrim(body) and body!~'^[[:space:]]*$'),
 version integer not null default 1 check(version between 1 and 999999999),
 sequence bigint generated always as identity check(sequence between 1 and 9007199254740991),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(sequence),
 foreign key(workspace_id,task_id) references public.tr8_workspace_tasks(workspace_id,id) on delete cascade
);
create index tr8_comments_task on tr8_private.task_comments(workspace_id,task_id,sequence desc);
create table tr8_private.comment_mentions (
 workspace_id uuid not null,comment_id uuid not null,member_id uuid not null,
 primary key(workspace_id,comment_id,member_id),
 foreign key(workspace_id,comment_id) references tr8_private.task_comments(workspace_id,id) on delete cascade,
 foreign key(workspace_id,member_id) references tr8_private.workspace_members(workspace_id,id) on delete cascade
);
create index tr8_comment_mentions_member on tr8_private.comment_mentions(workspace_id,member_id,comment_id);
create table tr8_private.comment_reactions (
 workspace_id uuid not null,comment_id uuid not null,member_id uuid not null,
 emoji text not null check(emoji=any(array['👍','🎉','❤️','👀','🚀','✅'])),
 primary key(workspace_id,comment_id,emoji,member_id),
 foreign key(workspace_id,comment_id) references tr8_private.task_comments(workspace_id,id) on delete cascade,
 foreign key(workspace_id,member_id) references tr8_private.workspace_members(workspace_id,id) on delete cascade
);
create index tr8_comment_reactions_member on tr8_private.comment_reactions(workspace_id,member_id,comment_id);
-- Minimal receipts outlive comments/tasks; UUID retries cannot resurrect content.
create table tr8_private.comment_receipts (
 id uuid primary key,workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 task_id uuid not null,author_id uuid not null,payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),
 deleted_version integer check(deleted_version between 1 and 999999999),
 created_at timestamptz not null default clock_timestamp()
);
create index tr8_comment_receipts_workspace on tr8_private.comment_receipts(workspace_id,task_id);
create table tr8_private.communication_notifications (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 recipient_member_id uuid not null,recipient_created_at timestamptz not null,
 project_id uuid not null,task_id uuid not null,comment_id uuid,
 kind text not null check(kind in('mention','comment','assignment')),
 actor_id uuid not null,source_version bigint not null,
 created_at timestamptz not null default clock_timestamp(),read_at timestamptz,
 check((kind='assignment')=(comment_id is null)),
 unique(workspace_id,task_id,recipient_member_id,kind,source_version),
 foreign key(workspace_id,recipient_member_id) references tr8_private.workspace_members(workspace_id,id) on delete cascade,
 foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete cascade,
 foreign key(workspace_id,task_id) references public.tr8_workspace_tasks(workspace_id,id) on delete cascade,
 foreign key(workspace_id,comment_id) references tr8_private.task_comments(workspace_id,id) on delete cascade
);
create index tr8_communication_inbox on tr8_private.communication_notifications(workspace_id,recipient_member_id,created_at desc,id desc);
create index tr8_communication_notification_comment on tr8_private.communication_notifications(workspace_id,comment_id);
create index tr8_communication_notification_project on tr8_private.communication_notifications(workspace_id,project_id);
alter table tr8_private.task_comments enable row level security;
alter table tr8_private.comment_mentions enable row level security;
alter table tr8_private.comment_reactions enable row level security;
alter table tr8_private.comment_receipts enable row level security;
alter table tr8_private.communication_notifications enable row level security;
revoke all on tr8_private.task_comments,tr8_private.comment_mentions,tr8_private.comment_reactions,
 tr8_private.comment_receipts,tr8_private.communication_notifications from public,anon,authenticated,service_role;
revoke all on sequence tr8_private.task_comments_sequence_seq from public,anon,authenticated,service_role;

create function tr8_private.communication_body(b jsonb) returns text
language plpgsql immutable security invoker set search_path='' as $$
begin
 if b is null or jsonb_typeof(b)<>'string' or length(b#>>'{}') not between 1 and 4000
  or b#>>'{}'<>btrim(b#>>'{}') or b#>>'{}'~'^[[:space:]]*$'
 then raise exception using errcode='22023',message='Comment must contain between 1 and 4000 characters';end if;
 return b#>>'{}';
end;$$;

create function tr8_private.communication_name(w uuid,u uuid) returns text
language sql stable security invoker set search_path='' as $$
 select case when u=auth.uid() then 'Tú'
  when tr8_private.v2_has_permission(w,'member.read') then coalesce((select a.display_name
   from tr8_private.app_users a join tr8_private.workspace_members m on m.user_id=a.user_id
   where m.workspace_id=w and m.user_id=u and m.status='active' and a.enabled),'Miembro')
  else 'Miembro' end;
$$;

-- The task SHARE lock excludes concurrent moves/removal while an authorized
-- conversation operation is in progress. Recheck its project after waiting.
create function tr8_private.communication_lock_task(w uuid,t uuid,permission text,writing boolean) returns uuid
language plpgsql volatile security invoker set search_path='' as $$
declare p uuid;current_p uuid;archived timestamptz;
begin
 select project_id into p from public.tr8_workspace_tasks where workspace_id=w and id=t;
 if p is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform tr8_private.v2_require_project(w,p,permission,writing);
 perform 1 from public.tr8_workspace_projects where workspace_id=w and id=p for share;
 select project_id,archived_at into current_p,archived from public.tr8_workspace_tasks where workspace_id=w and id=t for share;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if current_p is distinct from p then raise exception using errcode='PT409',message='A task moved. Reload its conversation';end if;
 if writing and (archived is not null or exists(select 1 from public.tr8_workspace_projects where workspace_id=w and id=p and archived_at is not null))
 then raise exception using errcode='55000',message='Restore the archived task or project before changing comments';end if;
 return p;
end;$$;

create function tr8_private.communication_comment(c tr8_private.task_comments) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',c.id,'workspace_id',c.workspace_id,'task_id',c.task_id,'author_id',c.author_id,
  'author_name',tr8_private.communication_name(c.workspace_id,c.author_id),'body',c.body,
  'mentions',coalesce((select jsonb_agg(jsonb_build_object('member_id',m.member_id,
    'display_name',tr8_private.communication_name(c.workspace_id,u.user_id)) order by m.member_id)
   from tr8_private.comment_mentions m join tr8_private.workspace_members u on u.workspace_id=m.workspace_id and u.id=m.member_id
   where m.workspace_id=c.workspace_id and m.comment_id=c.id),'[]'::jsonb),
  'reactions',coalesce((select jsonb_agg(jsonb_build_object('emoji',q.emoji,'count',q.n,'mine',q.mine) order by q.emoji)
   from(select r.emoji,count(*) n,bool_or(m.user_id=auth.uid()) mine from tr8_private.comment_reactions r
    join tr8_private.workspace_members m on m.workspace_id=r.workspace_id and m.id=r.member_id and m.status='active'
    join public.tr8_workspace_tasks t on t.workspace_id=c.workspace_id and t.id=c.task_id
    where r.workspace_id=c.workspace_id and r.comment_id=c.id
      and tr8_private.v2_project_readable_for(c.workspace_id,t.project_id,m.user_id,true) group by r.emoji)q),'[]'::jsonb),
  'version',c.version,'sequence',c.sequence,'created_at',c.created_at,'updated_at',c.updated_at,
  'can_edit',c.author_id=auth.uid() and tr8_private.v2_has_permission(c.workspace_id,'task.edit')
    and exists(select 1 from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.workspace_id=t.workspace_id and p.id=t.project_id
     where t.workspace_id=c.workspace_id and t.id=c.task_id and t.archived_at is null and p.archived_at is null
     and (tr8_private.v2_is_workspace_owner(c.workspace_id) or exists(select 1 from tr8_private.project_access a
      join tr8_private.workspace_members m on m.workspace_id=a.workspace_id and m.id=a.member_id
      where a.workspace_id=c.workspace_id and a.project_id=p.id and a.access_level='write' and m.user_id=auth.uid() and m.status='active'))),
  'can_delete',(c.author_id=auth.uid() and tr8_private.v2_has_permission(c.workspace_id,'task.edit')
    or tr8_private.v2_has_permission(c.workspace_id,'task.delete'))
    and exists(select 1 from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.workspace_id=t.workspace_id and p.id=t.project_id
     where t.workspace_id=c.workspace_id and t.id=c.task_id and t.archived_at is null and p.archived_at is null
     and (tr8_private.v2_is_workspace_owner(c.workspace_id) or exists(select 1 from tr8_private.project_access a
      join tr8_private.workspace_members m on m.workspace_id=a.workspace_id and m.id=a.member_id
      where a.workspace_id=c.workspace_id and a.project_id=p.id and a.access_level='write' and m.user_id=auth.uid() and m.status='active'))));
$$;

-- Recipient serialization keeps a strict 200-row retention cap under concurrent
-- assignments/comments. It never stores a comment body, title, email or secret.
create function tr8_private.communication_notify(w uuid,p uuid,t uuid,c uuid,k text,recipient uuid,actor uuid,source bigint) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare m tr8_private.workspace_members;
begin
 select * into m from tr8_private.workspace_members where workspace_id=w and id=recipient and status='active';
 if not found or m.user_id=actor or not tr8_private.v2_project_readable_for(w,p,m.user_id,true) then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('tr8-inbox:'||w::text||':'||recipient::text,0));
 insert into tr8_private.communication_notifications(workspace_id,recipient_member_id,recipient_created_at,project_id,task_id,comment_id,kind,actor_id,source_version)
 values(w,recipient,m.created_at,p,t,c,k,actor,source) on conflict do nothing;
 delete from tr8_private.communication_notifications where workspace_id=w and recipient_member_id=recipient and id in(
  select id from tr8_private.communication_notifications where workspace_id=w and recipient_member_id=recipient order by created_at desc,id desc offset 200);
end;$$;

create function tr8_private.communication_notification_visible(n tr8_private.communication_notifications) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from tr8_private.workspace_members m
  join public.tr8_workspace_tasks t on t.workspace_id=n.workspace_id and t.id=n.task_id and t.project_id=n.project_id
  where m.workspace_id=n.workspace_id and m.id=n.recipient_member_id and m.user_id=auth.uid() and m.status='active' and m.created_at=n.recipient_created_at
   and tr8_private.v2_project_readable_for(n.workspace_id,t.project_id,auth.uid(),true)
   and (n.comment_id is not null and exists(select 1 from tr8_private.task_comments c where c.workspace_id=n.workspace_id and c.id=n.comment_id and c.task_id=t.id)
    or n.kind='assignment' and t.assignee_member_id=m.id));
$$;
create function tr8_private.communication_notification(n tr8_private.communication_notifications) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',n.id,'workspace_id',n.workspace_id,'project_id',n.project_id,'task_id',n.task_id,'comment_id',n.comment_id,'kind',n.kind,
  'actor_name',tr8_private.communication_name(n.workspace_id,n.actor_id),'project_name',p.name,'project_color',p.color,'project_icon',p.icon,
  'task_title',t.title,'created_at',n.created_at,'read_at',n.read_at)
 from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.workspace_id=t.workspace_id and p.id=t.project_id
 where t.workspace_id=n.workspace_id and t.id=n.task_id and p.id=n.project_id;
$$;

create function tr8_private.communication(w uuid,a text,i jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare actor uuid:=auth.uid();member uuid;cid uuid;t uuid;p uuid;v integer;b text;h text;mentions uuid[];before_seq bigint;lim integer:=50;
 c tr8_private.task_comments;r tr8_private.comment_receipts;n tr8_private.communication_notifications;row record;
 ids bigint[];items jsonb;participants jsonb;last_seq bigint;affected integer;permission text;
begin
 perform tr8_private.v7_require_browser_session();
 perform tr8_private.v2_require_workspace(w,'project.read');
 select id into member from tr8_private.workspace_members where workspace_id=w and user_id=actor and status='active';
 if member is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if a is null or a<>all(array['thread','create','update','delete','react','inbox','read','read_all','dismiss'])
  or i is null or jsonb_typeof(i)<>'object' or octet_length(i::text)>24000
 then raise exception using errcode='22023',message='Invalid communication request';end if;
 if a in('inbox','read_all') then perform tr8_private.productivity_keys(i,array[]::text[]);
 elsif a='thread' then
  perform tr8_private.productivity_keys(i,array['task_id','before_id','limit']);
  t:=tr8_private.planning_id(i->'task_id');
  if i?'limit' then
   if jsonb_typeof(i->'limit')<>'number' or i->>'limit'!~'^[1-9][0-9]?$' or (i->>'limit')::integer>50
   then raise exception using errcode='22023',message='Invalid conversation page size';end if;
   lim:=(i->>'limit')::integer;
  end if;
  if i?'before_id' and i->'before_id'<>'null'::jsonb then
   if jsonb_typeof(i->'before_id')<>'number' or i->>'before_id'!~'^[1-9][0-9]{0,15}$' or (i->>'before_id')::numeric>9007199254740991
   then raise exception using errcode='22023',message='Invalid conversation cursor';end if;
   before_seq:=(i->>'before_id')::bigint;
  end if;
 elsif a='create' then
  perform tr8_private.productivity_keys(i,array['id','task_id','body','mention_member_ids']);
  cid:=tr8_private.planning_id(i->'id');t:=tr8_private.planning_id(i->'task_id');b:=tr8_private.communication_body(i->'body');
  if jsonb_typeof(i->'mention_member_ids') is distinct from 'array' or jsonb_array_length(i->'mention_member_ids')>10
  then raise exception using errcode='22023',message='Invalid comment mentions';end if;
  select coalesce(array_agg(distinct tr8_private.planning_id(value) order by tr8_private.planning_id(value)),array[]::uuid[]) into mentions from jsonb_array_elements(i->'mention_member_ids');
  if cardinality(mentions)<>jsonb_array_length(i->'mention_member_ids') then raise exception using errcode='22023',message='Duplicate comment mention';end if;
 elsif a='update' then
  perform tr8_private.productivity_keys(i,array['id','version','body']);cid:=tr8_private.planning_id(i->'id');v:=tr8_private.planning_version(i->'version');b:=tr8_private.communication_body(i->'body');
 elsif a='delete' then
  perform tr8_private.productivity_keys(i,array['id','version']);cid:=tr8_private.planning_id(i->'id');v:=tr8_private.planning_version(i->'version');
 elsif a='react' then
  perform tr8_private.productivity_keys(i,array['id','emoji','active']);cid:=tr8_private.planning_id(i->'id');
  if jsonb_typeof(i->'active') is distinct from 'boolean' or jsonb_typeof(i->'emoji') is distinct from 'string'
   or i->>'emoji'<>all(array['👍','🎉','❤️','👀','🚀','✅']) then raise exception using errcode='22023',message='Invalid reaction';end if;
 else
  perform tr8_private.productivity_keys(i,case when a='read' then array['id','read'] else array['id'] end);cid:=tr8_private.planning_id(i->'id');
  if a='read' and jsonb_typeof(i->'read') is distinct from 'boolean' then raise exception using errcode='22023',message='Invalid notification read state';end if;
 end if;
 if a='inbox' then
  select coalesce(jsonb_agg(tr8_private.communication_notification(q) order by q.created_at desc,q.id desc),'[]'::jsonb),
   count(*) filter(where q.read_at is null) into items,affected
   from tr8_private.communication_notifications q where q.workspace_id=w and q.recipient_member_id=member and tr8_private.communication_notification_visible(q);
  return jsonb_build_object('items',items,'unread_count',affected);
 elsif a='read_all' then
  update tr8_private.communication_notifications q set read_at=clock_timestamp() where q.workspace_id=w and q.recipient_member_id=member
   and q.read_at is null and tr8_private.communication_notification_visible(q);
  get diagnostics affected=row_count;return jsonb_build_object('updated',affected);
 elsif a in('read','dismiss') then
  select * into n from tr8_private.communication_notifications q where q.workspace_id=w and q.id=cid and q.recipient_member_id=member for update;
  if not found or not tr8_private.communication_notification_visible(n) then raise exception using errcode='PT404',message='Resource unavailable';end if;
  if a='dismiss' then delete from tr8_private.communication_notifications where id=cid;return jsonb_build_object('id',cid,'dismissed',true);end if;
  update tr8_private.communication_notifications set read_at=case when (i->>'read')::boolean then coalesce(read_at,clock_timestamp()) else null end where id=cid;
  return jsonb_build_object('id',cid,'read',(i->>'read')::boolean);
 end if;
 if a not in('thread') then perform pg_advisory_xact_lock(hashtextextended('tr8-communication:'||w::text,0));end if;
 if a not in('thread','create') then
  select * into c from tr8_private.task_comments where workspace_id=w and id=cid;
  if not found then
   -- Idempotent delete requires an exact scoped receipt and original version.
   select * into r from tr8_private.comment_receipts where workspace_id=w and id=cid;
   if a='delete' and r.deleted_version=v then
    perform tr8_private.communication_lock_task(w,r.task_id,case when r.author_id=actor then 'task.edit' else 'task.delete' end,true);
    return jsonb_build_object('id',cid,'deleted',true);
   end if;
   raise exception using errcode='PT404',message='Resource unavailable';
  end if;t:=c.task_id;
 end if;
 permission:=case when a='thread' then 'task.read' when a='delete' and c.author_id<>actor then 'task.delete' else 'task.edit' end;
 p:=tr8_private.communication_lock_task(w,t,permission,a<>'thread');
 if a='thread' then
  select array_agg(q.sequence order by q.sequence desc) into ids from(select sequence from tr8_private.task_comments
   where workspace_id=w and task_id=t and (before_seq is null or sequence<before_seq) order by sequence desc limit lim+1)q;
  if cardinality(ids)>lim then last_seq:=ids[lim];end if;
  select coalesce(jsonb_agg(tr8_private.communication_comment(q) order by q.sequence desc),'[]'::jsonb) into items
   from tr8_private.task_comments q where workspace_id=w and task_id=t and q.sequence=any(ids[1:lim]);
  participants:='[]'::jsonb;
  if tr8_private.v2_has_permission(w,'member.read') then
   select coalesce(jsonb_agg(jsonb_build_object('member_id',q.id,'display_name',q.display_name) order by q.display_name,q.id),'[]'::jsonb) into participants
    from(select m.id,u.display_name from tr8_private.workspace_members m join tr8_private.app_users u on u.user_id=m.user_id
     where m.workspace_id=w and m.status='active' and tr8_private.v2_project_readable_for(w,p,m.user_id,true)
     order by u.display_name,m.id limit 200)q;
  end if;
  return jsonb_build_object('items',items,'next_before_id',last_seq,'participants',participants);
 elsif a='create' then
  h:=encode(sha256(convert_to(jsonb_build_object('task_id',t,'body',b,'mentions',mentions)::text,'UTF8')),'hex');
  select * into r from tr8_private.comment_receipts where id=cid;
  if found then
   if r.workspace_id<>w or r.task_id<>t or r.author_id<>actor or r.payload_hash<>h or r.deleted_version is not null
   then raise exception using errcode='PT409',message='Comment request identity was already used';end if;
   select * into c from tr8_private.task_comments where workspace_id=w and id=cid;
   if not found then raise exception using errcode='PT409',message='Comment request identity was already used';end if;
   return tr8_private.communication_comment(c);
  end if;
  if (select count(*) from tr8_private.task_comments where workspace_id=w and task_id=t)>=500
   or (select count(*) from tr8_private.task_comments where workspace_id=w)>=5000
   or (select count(*) from tr8_private.comment_receipts where workspace_id=w)>=10000
  then raise exception using errcode='PT413',message='Conversation capacity reached';end if;
  if cardinality(mentions)>0 and (not tr8_private.v2_has_permission(w,'member.read') or exists(select 1 from unnest(mentions)m
   where not tr8_private.v2_assignee_eligible(w,p,m))) then raise exception using errcode='PT404',message='Mention participant unavailable';end if;
  insert into tr8_private.comment_receipts(id,workspace_id,task_id,author_id,payload_hash) values(cid,w,t,actor,h);
  insert into tr8_private.task_comments(id,workspace_id,task_id,author_id,body) values(cid,w,t,actor,b) returning * into c;
  insert into tr8_private.comment_mentions(workspace_id,comment_id,member_id) select w,cid,m from unnest(mentions)m;
  -- Mention wins over comment for a recipient appearing in both sources.
  for row in select m.id,case when m.id=any(mentions) then 'mention' else 'comment' end kind from tr8_private.workspace_members m
   join public.tr8_workspace_tasks q on q.workspace_id=w and q.id=t
   where m.workspace_id=w and m.status='active' and (m.id=any(mentions) or m.user_id=q.owner_id or m.id=q.assignee_member_id) order by m.id loop
   perform tr8_private.communication_notify(w,p,t,cid,row.kind,row.id,actor,c.sequence);
  end loop;
 elsif a='update' then
  if c.author_id<>actor then raise exception using errcode='PT404',message='Resource unavailable';end if;
  if c.version<>v then raise exception using errcode='PT409',message='Comment changed. Reload before editing';end if;
  update tr8_private.task_comments set body=b,version=version+1,updated_at=clock_timestamp() where id=cid returning * into c;
 elsif a='delete' then
  if c.version<>v then raise exception using errcode='PT409',message='Comment changed. Reload before deleting';end if;
  update tr8_private.comment_receipts set deleted_version=v where workspace_id=w and id=cid;
  delete from tr8_private.task_comments where workspace_id=w and id=cid;
 elsif a='react' then
  if (i->>'active')::boolean then
   if not exists(select 1 from tr8_private.comment_reactions where workspace_id=w and comment_id=cid and member_id=member and emoji=i->>'emoji')
    and (select count(*) from tr8_private.comment_reactions where workspace_id=w and comment_id=cid and emoji=i->>'emoji')>=20000
   then raise exception using errcode='PT413',message='Reaction capacity reached';end if;
   insert into tr8_private.comment_reactions(workspace_id,comment_id,member_id,emoji) values(w,cid,member,i->>'emoji') on conflict do nothing;
  else delete from tr8_private.comment_reactions where workspace_id=w and comment_id=cid and member_id=member and emoji=i->>'emoji';end if;
  return tr8_private.communication_comment(c);
 end if;
 insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
 values(w,p,actor,case a when 'create' then 'comment.created' when 'update' then 'comment.updated' else 'comment.deleted' end,cid);
 if a='delete' then return jsonb_build_object('id',cid,'deleted',true);end if;
 return tr8_private.communication_comment(c);
end;$$;

create function public.tr8_v2_communication(p_workspace_id uuid,p_action text,p_input jsonb default '{}') returns jsonb
language sql volatile security invoker set search_path='' as $$select tr8_private.communication(p_workspace_id,p_action,p_input);$$;

create function tr8_private.communication_move_guard() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 if new.project_id is distinct from old.project_id and exists(select 1 from tr8_private.task_comments where workspace_id=old.workspace_id and task_id=old.id)
 then raise exception using errcode='PT422',message='Task comments must be removed before moving this task';end if;
 return new;
end;$$;
create trigger tr8_communication_move_guard before update of project_id on public.tr8_workspace_tasks
 for each row execute function tr8_private.communication_move_guard();

create function tr8_private.communication_assignment_capture() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 if new.assignee_member_id is null or new.archived_at is not null or (tg_op='UPDATE' and new.assignee_member_id is not distinct from old.assignee_member_id)
  or auth.uid() is null or not tr8_private.v2_actor_enabled()
  or exists(select 1 from public.tr8_workspace_projects where workspace_id=new.workspace_id and id=new.project_id and archived_at is not null)
 then return new;end if;
 perform tr8_private.communication_notify(new.workspace_id,new.project_id,new.id,null,'assignment',new.assignee_member_id,auth.uid(),new.version);
 return new;
end;$$;
create trigger tr8_communication_assignment_capture after insert or update of assignee_member_id on public.tr8_workspace_tasks
 for each row execute function tr8_private.communication_assignment_capture();

-- A removed incarnation must not recover old notices if an operator ever
-- reinstates it. Role-version changes alone do not discard relevant notices.
create function tr8_private.communication_member_removed() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 if new.status is distinct from old.status then delete from tr8_private.communication_notifications where workspace_id=new.workspace_id and recipient_member_id=new.id;end if;
 return new;
end;$$;
create trigger tr8_communication_member_removed after update of status on tr8_private.workspace_members
 for each row execute function tr8_private.communication_member_removed();

revoke all on function tr8_private.communication_body(jsonb),tr8_private.communication_name(uuid,uuid),
 tr8_private.communication_lock_task(uuid,uuid,text,boolean),tr8_private.communication_comment(tr8_private.task_comments),
 tr8_private.communication_notify(uuid,uuid,uuid,uuid,text,uuid,uuid,bigint),
 tr8_private.communication_notification_visible(tr8_private.communication_notifications),
 tr8_private.communication_notification(tr8_private.communication_notifications),tr8_private.communication(uuid,text,jsonb),
 public.tr8_v2_communication(uuid,text,jsonb),tr8_private.communication_move_guard(),tr8_private.communication_assignment_capture(),
 tr8_private.communication_member_removed() from public,anon,authenticated,service_role;
grant execute on function tr8_private.communication(uuid,text,jsonb),public.tr8_v2_communication(uuid,text,jsonb) to authenticated;

do $$declare original record;begin
 select * into strict original from tr8_communication_before;
 if original.projects is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p)
  or original.tasks is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t)
  or original.finances is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f)
  or original.config is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c)
  or exists(select 1 from tr8_private.task_comments) or exists(select 1 from tr8_private.communication_notifications)
 then raise exception 'Communication stage 7 unexpectedly changed existing data';end if;
end;$$;
notify pgrst,'reload schema';
commit;

