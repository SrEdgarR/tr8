-- Refine private notice lifecycle and own-comment moderation without changing prior migrations.
begin;
create or replace function tr8_private.communication(w uuid,a text,i jsonb) returns jsonb
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
  if a='dismiss' then
   -- A lost acknowledgement is safe to replay. An arbitrary UUID reveals no
   -- existence or recipient data and can only remove this member's own row.
   delete from tr8_private.communication_notifications where workspace_id=w and id=cid and recipient_member_id=member;
   return jsonb_build_object('id',cid,'dismissed',true);
  end if;
  select * into n from tr8_private.communication_notifications q where q.workspace_id=w and q.id=cid and q.recipient_member_id=member for update;
  if not found or not tr8_private.communication_notification_visible(n) then raise exception using errcode='PT404',message='Resource unavailable';end if;
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
    perform tr8_private.communication_lock_task(w,r.task_id,case when r.author_id=actor and tr8_private.v2_has_permission(w,'task.edit') then 'task.edit' else 'task.delete' end,true);
    return jsonb_build_object('id',cid,'deleted',true);
   end if;
   raise exception using errcode='PT404',message='Resource unavailable';
  end if;t:=c.task_id;
 end if;
 permission:=case when a='thread' then 'task.read' when a='delete' and (c.author_id<>actor or not tr8_private.v2_has_permission(w,'task.edit')) then 'task.delete' else 'task.edit' end;
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

create or replace function tr8_private.communication_assignment_capture() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and new.assignee_member_id is not distinct from old.assignee_member_id then return new;end if;
 -- Retire previous assignment incarnations even on unassignment. A later
 -- re-assignment to the same member produces only the new relevant notice.
 delete from tr8_private.communication_notifications where workspace_id=new.workspace_id and task_id=new.id and kind='assignment';
 if new.assignee_member_id is null or new.archived_at is not null
  or auth.uid() is null or not tr8_private.v2_actor_enabled()
  or exists(select 1 from public.tr8_workspace_projects where workspace_id=new.workspace_id and id=new.project_id and archived_at is not null)
 then return new;end if;
 perform tr8_private.communication_notify(new.workspace_id,new.project_id,new.id,null,'assignment',new.assignee_member_id,auth.uid(),new.version);
 return new;
end;$$;
revoke all on function tr8_private.communication(uuid,text,jsonb),tr8_private.communication_assignment_capture() from public,anon,authenticated,service_role;
grant execute on function tr8_private.communication(uuid,text,jsonb) to authenticated;
commit;
