-- TEST ONLY. Synthetic conversations/notifications; everything rolls back.
begin;
select set_config('tr8.communication_checks','0',true);
create temporary table comm_values(k text primary key,v jsonb) on commit drop;
create temporary table comm_existing on commit drop as
 select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
 union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
 union all select 'finances',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create temporary table comm_config on commit drop as select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) hash from tr8_private.app_config c;
create function pg_temp.c_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Communication assertion: %',label;end if;
 perform set_config('tr8.communication_checks',(current_setting('tr8.communication_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.c_error(command text,code text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=code then perform pg_temp.c_assert(true,label);return;end if;
  raise exception 'Communication expected % got % (%) for %',code,sqlstate,sqlerrm,label;
 end;raise exception 'Communication unexpectedly allowed: %',label;
end;$$;
create function pg_temp.c_actor(a uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.c(a text,i jsonb default '{}') returns jsonb language sql as $$select public.tr8_v2_communication('d9670000-0000-4000-8000-000000000001',a,i);$$;
create function pg_temp.c_create(id uuid,t uuid default 'e9670000-0000-4000-8000-000000000001',body text default 'A useful comment',mentions jsonb default '[]') returns jsonb language sql as $$
 select jsonb_build_object('id',id,'task_id',t,'body',body,'mention_member_ids',mentions);
$$;
create function pg_temp.c_thread(t uuid default 'e9670000-0000-4000-8000-000000000001',before_id bigint default null,lim integer default 50) returns jsonb language sql as $$
 select pg_temp.c('thread',jsonb_build_object('task_id',t,'before_id',before_id,'limit',lim));
$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update,delete on comm_values to authenticated;
grant execute on function pg_temp.c_assert(boolean,text),pg_temp.c_error(text,text,text),pg_temp.c_actor(uuid),pg_temp.c(text,jsonb),
 pg_temp.c_create(uuid,uuid,text,jsonb),pg_temp.c_thread(uuid,bigint,integer) to authenticated,anon;

select pg_temp.c_assert(not has_function_privilege('anon','public.tr8_v2_communication(uuid,text,jsonb)','execute'),'anon wrapper denied');
select pg_temp.c_assert(not has_function_privilege('service_role','public.tr8_v2_communication(uuid,text,jsonb)','execute'),'service role cannot impersonate a browser');
select pg_temp.c_assert(has_function_privilege('authenticated','public.tr8_v2_communication(uuid,text,jsonb)','execute'),'authenticated wrapper callable');
select pg_temp.c_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_communication(uuid,text,jsonb)'::regprocedure),'public wrapper invoker and empty search path');
select pg_temp.c_assert((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='tr8_private.communication(uuid,text,jsonb)'::regprocedure),'private gateway definer and empty search path');
select pg_temp.c_assert((select bool_and(relrowsecurity) from pg_class where oid in('tr8_private.task_comments'::regclass,'tr8_private.comment_mentions'::regclass,'tr8_private.comment_reactions'::regclass,'tr8_private.comment_receipts'::regclass,'tr8_private.communication_notifications'::regclass)),'all conversation tables enable RLS');
select pg_temp.c_assert(not has_table_privilege('authenticated','tr8_private.task_comments','select') and not has_table_privilege('authenticated','tr8_private.communication_notifications','update'),'no direct table grants');
select pg_temp.c_assert(not has_table_privilege('service_role','tr8_private.comment_receipts','select'),'receipts private from service role');
select pg_temp.c_assert(not has_function_privilege('authenticated','tr8_private.communication_notify(uuid,uuid,uuid,uuid,text,uuid,uuid,bigint)','execute'),'arbitrary recipient helper private');
select pg_temp.c_assert(not has_sequence_privilege('authenticated','tr8_private.task_comments_sequence_seq','usage'),'client cannot mint comment sequence');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f9670000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','communication-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,4)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'f9670000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Synthetic communication user '||right(id::text,1) from auth.users where id::text like 'f9670000-%';
set local role authenticated;
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('d9670000-0000-4000-8000-000000000001','Synthetic communication');
select public.tr8_v2_create_team('d9670000-0000-4000-8000-000000000002','Foreign communication');
select public.tr8_v2_create_project('d9670000-0000-4000-8000-000000000001','a9671001-0001-4000-8000-000000000001','Conversation project','','#5A67D8','active');
select public.tr8_v2_create_project('d9670000-0000-4000-8000-000000000001','a9671002-0002-4000-8000-000000000002','Hidden destination','','#0284C7','active');
select public.tr8_v2_create_project('d9670000-0000-4000-8000-000000000002','a9671003-0003-4000-8000-000000000003','Foreign project','','#D97706','active');
select public.tr8_v2_create_task('d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000001','a9671001-0001-4000-8000-000000000001','Conversation task','','todo','none',null,null);
select public.tr8_v2_create_task('d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000002','a9671002-0002-4000-8000-000000000002','Hidden task','','todo','none',null,null);
select public.tr8_v2_create_task('d9670000-0000-4000-8000-000000000002','e9670000-0000-4000-8000-000000000003','a9671003-0003-4000-8000-000000000003','Foreign task','','todo','none',null,null);
select public.tr8_v2_create_task('d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000004','a9671001-0001-4000-8000-000000000001','Quota task','','todo','none',null,null);
insert into comm_values select 'task_before',to_jsonb(t) from public.tr8_workspace_tasks t where id='e9670000-0000-4000-8000-000000000001';
reset role;
insert into comm_values select 'owner_member',to_jsonb(id) from tr8_private.workspace_members where workspace_id='d9670000-0000-4000-8000-000000000001' and user_id='f9670000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.c_assert(pg_temp.c_thread()->'items'='[]'::jsonb and pg_temp.c_thread()->'next_before_id'='null'::jsonb,'new thread contains no fabricated comments');
select pg_temp.c_assert(pg_temp.c('inbox')='{"items":[],"unread_count":0}'::jsonb,'new inbox contains no fabricated notices');
insert into comm_values values('own',pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000001')));
select pg_temp.c_assert((select v->>'author_id'='f9670000-0000-4000-8000-000000000001' and v->>'author_name'='Tú' and v->>'version'='1' and (v->>'sequence')::bigint>0 and v->>'can_edit'='true' and v->>'can_delete'='true' from comm_values where k='own'),'server identity timestamps/version and permissions');
select pg_temp.c_assert((select (select count(*) from jsonb_object_keys(v))=14 from comm_values where k='own'),'comment exact 14-field DTO');
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='0','own comment does not notify its author');
select pg_temp.c_assert(pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000001'))=(select v from comm_values where k='own'),'exact create retry returns one comment');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000001')||'{"body":"Different"}')$q$,'PT409','create identity bound to original content');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||'{"owner_id":"forged"}')$q$,'22023','closed input rejects forged ownership');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||'{"body":""}')$q$,'22023','empty body denied');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||'{"body":"   "}')$q$,'22023','space-only body denied');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||jsonb_build_object('body',E'\n\t'))$q$,'22023','whitespace-only body denied');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||jsonb_build_object('body',repeat('a',4001)))$q$,'22023','body codepoint cap enforced');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||jsonb_build_object('body','bad'||chr(1)||'text'))$q$,'22023','C0 control body rejected');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||jsonb_build_object('body','bad'||chr(127)||'text'))$q$,'22023','DEL control body rejected');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||jsonb_build_object('body','bad'||chr(159)||'text'))$q$,'22023','C1 control body rejected');
insert into comm_values values('unicode',pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000010')||jsonb_build_object('body',repeat(chr(128512),4000))));
select pg_temp.c_assert((select length(v->>'body')=4000 from comm_values where k='unicode'),'4000 astral Unicode codepoints accepted');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000011')||'{"mention_member_ids":null}')$q$,'22023','null mentions denied');
select pg_temp.c_error($q$select pg_temp.c('thread','{"task_id":"e9670000-0000-4000-8000-000000000001","before_id":null,"limit":51}')$q$,'22023','page upper bound enforced');
select pg_temp.c_error($q$select pg_temp.c('thread','{"task_id":"e9670000-0000-4000-8000-000000000001","before_id":0,"limit":50}')$q$,'22023','zero cursor denied');
select pg_temp.c_error($q$select pg_temp.c('thread','{"task_id":"e9670000-0000-4000-8000-000000000001","before_id":9007199254740992,"limit":50}')$q$,'22023','unsafe JS cursor denied');
select pg_temp.c_error($q$select pg_temp.c('thread','{"task_id":"e9670000-0000-4000-8000-000000000001","before_id":"1","limit":50}')$q$,'22023','string cursor denied');
select pg_temp.c_error($q$select pg_temp.c_thread('e9670000-0000-4000-8000-000000000003')$q$,'PT404','cross-workspace task denied');

reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id) values
 ('b9670000-0000-4000-8000-000000000002','d9670000-0000-4000-8000-000000000001','f9670000-0000-4000-8000-000000000002'),
 ('b9670000-0000-4000-8000-000000000003','d9670000-0000-4000-8000-000000000001','f9670000-0000-4000-8000-000000000003');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
 select workspace_id,case when template_key='collaborator' then 'b9670000-0000-4000-8000-000000000002'::uuid else 'b9670000-0000-4000-8000-000000000003'::uuid end,id
 from tr8_private.workspace_roles where workspace_id='d9670000-0000-4000-8000-000000000001' and template_key in('collaborator','read');
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values
 ('d9670000-0000-4000-8000-000000000001','a9671001-0001-4000-8000-000000000001','b9670000-0000-4000-8000-000000000002','write'),
 ('d9670000-0000-4000-8000-000000000001','a9671001-0001-4000-8000-000000000001','b9670000-0000-4000-8000-000000000003','read');
set local role authenticated;
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c_thread()->'participants')=3,'mention participants restricted to live eligible project members');
select pg_temp.c_assert(pg_temp.c_thread()->'items'->0->>'author_name'='Synthetic communication user 1','directory permission allows current names');
select pg_temp.c_assert(pg_temp.c_thread()->'items'->0->>'can_edit'='false' and pg_temp.c_thread()->'items'->0->>'can_delete'='false','collaborator cannot edit or moderate another author');
select pg_temp.c_error($q$select pg_temp.c_thread('e9670000-0000-4000-8000-000000000002')$q$,'PT404','workspace membership gives no hidden project conversation');
select pg_temp.c_error($q$select pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000001","version":1}')$q$,'PT404','collaborator cannot delete another author');
select pg_temp.c_error($q$select pg_temp.c('update','{"id":"c9670000-0000-4000-8000-000000000001","version":1,"body":"forged"}')$q$,'PT404','collaborator cannot edit another author');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000020')||'{"mention_member_ids":["b9670000-0000-4000-8000-000000000004"]}')$q$,'PT404','unavailable mention cannot grant access');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000020')||'{"mention_member_ids":["b9670000-0000-4000-8000-000000000003","b9670000-0000-4000-8000-000000000003"]}')$q$,'22023','duplicate mentions rejected');
insert into comm_values values('collab',pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000020')||jsonb_build_object('mention_member_ids',jsonb_build_array((select v#>>'{}' from comm_values where k='owner_member'),'b9670000-0000-4000-8000-000000000003'))));
select pg_temp.c_assert((select jsonb_array_length(v->'mentions')=2 and v->>'can_edit'='true' from comm_values where k='collab'),'author can edit with structured mentions');
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='0','collaborator does not self-notify');
insert into comm_values values('reacted',pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"👍","active":true}'));
select pg_temp.c_assert((select v->>'version'='1' and v->'reactions'='[{"emoji":"👍","count":1,"mine":true}]'::jsonb from comm_values where k='reacted'),'reaction exact desired state and unchanged comment version');
select pg_temp.c_assert(pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"👍","active":true}')=(select v from comm_values where k='reacted'),'reaction retry does not invert or duplicate');
select pg_temp.c_assert(pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"👍","active":false}')->'reactions'='[]'::jsonb,'desired inactive removes only own reaction');
select pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"👍","active":true}');
select pg_temp.c_error($q$select pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"evil","active":true}')$q$,'22023','reaction catalog closed');
select pg_temp.c_error($q$select pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"👍","active":"true"}')$q$,'22023','reaction active must be boolean');
insert into comm_values values('edited',pg_temp.c('update','{"id":"c9670000-0000-4000-8000-000000000020","version":1,"body":"Updated text"}'));
select pg_temp.c_assert((select v->>'version'='2' and v->>'body'='Updated text' and v->'mentions'=(select v->'mentions' from comm_values where k='collab') from comm_values where k='edited'),'edit CAS changes text and preserves fixed mentions');
select pg_temp.c_error($q$select pg_temp.c('update','{"id":"c9670000-0000-4000-8000-000000000020","version":1,"body":"Stale"}')$q$,'PT409','stale edit cannot overwrite');
select pg_temp.c_assert(pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000020')||jsonb_build_object('mention_member_ids',jsonb_build_array((select v#>>'{}' from comm_values where k='owner_member'),'b9670000-0000-4000-8000-000000000003')))->>'body'='Updated text','lost create response returns current edited object, no resurrection');

select pg_temp.c_actor('f9670000-0000-4000-8000-000000000003');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c_thread()->'items')=3,'read-only project member reads conversation');
select pg_temp.c_assert(pg_temp.c_thread()->'items'->0->>'can_edit'='false' and pg_temp.c_thread()->'items'->0->>'can_delete'='false','read-only DTO has no write actions');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000030'))$q$,'PT404','read-only member cannot post');
select pg_temp.c_error($q$select pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"👍","active":true}')$q$,'PT404','read-only member cannot react');
insert into comm_values values('reader_inbox',pg_temp.c('inbox'));
select pg_temp.c_assert((select jsonb_array_length(v->'items')=1 and v->>'unread_count'='1' and v->'items'->0->>'kind'='mention' from comm_values where k='reader_inbox'),'reader receives a single mention despite comment edits/retries');
select pg_temp.c_assert((select (select count(*) from jsonb_object_keys(v->'items'->0))=13 and not(v->'items'->0?'body') and not(v->'items'->0?'snippet') from comm_values where k='reader_inbox'),'notice exact minimal DTO with live resource names and no body copy');
select pg_temp.c_assert(pg_temp.c('read',jsonb_build_object('id',(select v->'items'->0->>'id' from comm_values where k='reader_inbox'),'read',true))->>'read'='true','read own notification');
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='0','read counter refreshed');
select pg_temp.c('read',jsonb_build_object('id',(select v->'items'->0->>'id' from comm_values where k='reader_inbox'),'read',false));
select pg_temp.c_assert(pg_temp.c('read_all')->>'updated'='1' and pg_temp.c('read_all')->>'updated'='0','read all touches visible unread notices once');
select pg_temp.c('read',jsonb_build_object('id',(select v->'items'->0->>'id' from comm_values where k='reader_inbox'),'read',false));

select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
insert into comm_values values('owner_inbox',pg_temp.c('inbox'));
select pg_temp.c_assert((select jsonb_array_length(v->'items')=1 and v->'items'->0->>'kind'='mention' from comm_values where k='owner_inbox'),'mention wins over creator comment, deduplicated');
select pg_temp.c_error($q$select pg_temp.c('read',jsonb_build_object('id',(select v->'items'->0->>'id' from comm_values where k='reader_inbox'),'read',true))$q$,'PT404','owner cannot alter another recipient notice');
select pg_temp.c_error($q$select public.tr8_v2_communication('d9670000-0000-4000-8000-000000000002','read',jsonb_build_object('id',(select v->'items'->0->>'id' from comm_values where k='owner_inbox'),'read',true))$q$,'PT404','notification ID cannot cross workspace');
select pg_temp.c_error($q$select public.tr8_v2_work_management('d9670000-0000-4000-8000-000000000001','move_task',jsonb_build_object('id','e9670000-0000-4000-8000-000000000001','version',(select version from public.tr8_workspace_tasks where id='e9670000-0000-4000-8000-000000000001'),'target_project_id','a9671002-0002-4000-8000-000000000002','request_id','09670000-0000-4000-8000-000000000001','clear_assignee',false))$q$,'PT422','move with comments cannot leak source conversations');
select pg_temp.c_assert((select v=to_jsonb(t) from comm_values,public.tr8_workspace_tasks t where k='task_before' and t.id='e9670000-0000-4000-8000-000000000001'),'comments reactions and failed move preserve task data/version');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c_thread(nullif('e9670000-0000-4000-8000-000000000001','')::uuid,null,2)->'items')=2,'thread page size respected');
insert into comm_values values('page1',pg_temp.c_thread('e9670000-0000-4000-8000-000000000001',null,2));
select pg_temp.c_assert((select v->'items'->0->>'id'='c9670000-0000-4000-8000-000000000020' and (v->>'next_before_id')::bigint=(v->'items'->1->>'sequence')::bigint from comm_values where k='page1'),'descending sequence and cursor last row');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c_thread('e9670000-0000-4000-8000-000000000001',(select (v->>'next_before_id')::bigint from comm_values where k='page1'),2)->'items')=1,'next page excludes previous rows');
select pg_temp.c_assert(pg_temp.c_thread('e9670000-0000-4000-8000-000000000001',(select (v->>'next_before_id')::bigint from comm_values where k='page1'),2)->'next_before_id'='null'::jsonb,'last page cursor null');
select pg_temp.c_assert(pg_temp.c_thread()->'items'->0->>'can_delete'='true' and pg_temp.c_thread()->'items'->0->>'can_edit'='false','task.delete allows owner moderation but not impersonated editing');

reset role;
delete from tr8_private.role_permissions where workspace_id='d9670000-0000-4000-8000-000000000001' and permission='member.read' and role_id in(select id from tr8_private.workspace_roles where workspace_id='d9670000-0000-4000-8000-000000000001' and template_key='collaborator');
set local role authenticated;
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
select pg_temp.c_assert(pg_temp.c_thread()->'participants'='[]'::jsonb,'no directory permission exposes no participant list');
select pg_temp.c_assert(pg_temp.c_thread()->'items'->1->>'author_name'='Miembro','other author names hidden without directory');
select pg_temp.c_assert(pg_temp.c_thread()->'items'->0->'mentions'->0->>'display_name'='Miembro','structured mentions do not leak directory names');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000031')||'{"mention_member_ids":["b9670000-0000-4000-8000-000000000003"]}')$q$,'PT404','no directory permission cannot resolve guessed mention IDs');
select pg_temp.c_assert(pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000031'))->>'id'='c9670000-0000-4000-8000-000000000031','no directory permission may post without mentions');

reset role;
delete from tr8_private.project_access where workspace_id='d9670000-0000-4000-8000-000000000001' and member_id='b9670000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000003');
select pg_temp.c_assert(pg_temp.c('inbox')='{"items":[],"unread_count":0}'::jsonb,'revocation hides old notification and counters');
select pg_temp.c_error($q$select pg_temp.c_thread()$q$,'PT404','revoked project cannot read thread');
select pg_temp.c_error($q$select pg_temp.c('read',jsonb_build_object('id',(select v->'items'->0->>'id' from comm_values where k='reader_inbox'),'read',true))$q$,'PT404','revoked project cannot mark hidden notice');
select pg_temp.c_assert(pg_temp.c('read_all')->>'updated'='0','mark all does not touch hidden notices');
reset role;
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values('d9670000-0000-4000-8000-000000000001','a9671001-0001-4000-8000-000000000001','b9670000-0000-4000-8000-000000000003','read');
update tr8_private.workspace_members set status='removed' where id='b9670000-0000-4000-8000-000000000003';
select pg_temp.c_assert(not exists(select 1 from tr8_private.communication_notifications where recipient_member_id='b9670000-0000-4000-8000-000000000003'),'membership removal retires previous incarnation notices');
update tr8_private.workspace_members set status='active' where id='b9670000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='0','reinstatement does not recover old notifications');

select pg_temp.c_actor('f9670000-0000-4000-8000-000000000004');
select pg_temp.c_error($q$select pg_temp.c_thread()$q$,'PT404','outsider cannot read known task');
select pg_temp.c_error($q$select pg_temp.c('inbox')$q$,'PT404','outsider has no workspace inbox');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
reset role;
update public.tr8_workspace_tasks set archived_at=now() where id='e9670000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.c_assert(jsonb_array_length(pg_temp.c_thread()->'items')=4 and pg_temp.c_thread()->'items'->0->>'can_delete'='false','archived task retains read-only conversation');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000040'))$q$,'55000','archived task cannot post');
select pg_temp.c_error($q$select pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000020","version":2}')$q$,'55000','archived task cannot remove comments');
reset role;
update public.tr8_workspace_tasks set archived_at=null where id='e9670000-0000-4000-8000-000000000001';
update public.tr8_workspace_projects set archived_at=now() where id='a9671001-0001-4000-8000-000000000001';
set local role authenticated;
select pg_temp.c_assert(jsonb_array_length(pg_temp.c_thread()->'items')=4,'archived project retains read conversation');
select pg_temp.c_error($q$select pg_temp.c('react','{"id":"c9670000-0000-4000-8000-000000000020","emoji":"👍","active":true}')$q$,'55000','archived project cannot react');
reset role;
update public.tr8_workspace_projects set archived_at=null where id='a9671001-0001-4000-8000-000000000001';
set local role authenticated;

select pg_temp.c_error($q$select pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000020","version":1}')$q$,'PT409','stale delete cannot remove edited comment');
select pg_temp.c_assert(pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000020","version":2}')='{"id":"c9670000-0000-4000-8000-000000000020","deleted":true}'::jsonb,'moderation deletes exact comment');
select pg_temp.c_assert(pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000020","version":2}')->>'deleted'='true','lost delete ack replays receipt exact version');
select pg_temp.c_error($q$select pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000020","version":1}')$q$,'PT404','other delete version cannot replay tombstone');
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='1','deleted comment notification removed while unrelated comment notice remains');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670000-0000-4000-8000-000000000020')||jsonb_build_object('mention_member_ids',jsonb_build_array((select v#>>'{}' from comm_values where k='owner_member'),'b9670000-0000-4000-8000-000000000003')))$q$,'PT409','deleted create identity cannot resurrect text');
reset role;
delete from tr8_private.role_permissions where workspace_id='d9670000-0000-4000-8000-000000000001' and permission='task.edit' and role_id in(select id from tr8_private.workspace_roles where workspace_id='d9670000-0000-4000-8000-000000000001' and template_key='collaborator');
insert into tr8_private.role_permissions(workspace_id,role_id,permission) select workspace_id,id,'task.delete' from tr8_private.workspace_roles where workspace_id='d9670000-0000-4000-8000-000000000001' and template_key='collaborator';
set local role authenticated;
select pg_temp.c_assert(pg_temp.c_thread()->'items'->0->>'can_edit'='false' and pg_temp.c_thread()->'items'->0->>'can_delete'='true','own comment delete-only role has coherent action flags');
select pg_temp.c_error($q$select pg_temp.c('update','{"id":"c9670000-0000-4000-8000-000000000031","version":1,"body":"forged edit"}')$q$,'PT404','delete-only role cannot edit own comment');
select pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000031","version":1}');
select pg_temp.c_assert(pg_temp.c('delete','{"id":"c9670000-0000-4000-8000-000000000031","version":1}')->>'deleted'='true','own delete receipt idempotent');
reset role;
delete from tr8_private.role_permissions where workspace_id='d9670000-0000-4000-8000-000000000001' and permission='task.delete' and role_id in(select id from tr8_private.workspace_roles where workspace_id='d9670000-0000-4000-8000-000000000001' and template_key='collaborator');
insert into tr8_private.role_permissions(workspace_id,role_id,permission) select workspace_id,id,'task.edit' from tr8_private.workspace_roles where workspace_id='d9670000-0000-4000-8000-000000000001' and template_key='collaborator';
set local role authenticated;
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='0','deleting own comment retires its recipient notice');
select public.tr8_v2_assign_task('d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000001',(select version from public.tr8_workspace_tasks where id='e9670000-0000-4000-8000-000000000001'),'b9670000-0000-4000-8000-000000000002');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
insert into comm_values values('assignment',pg_temp.c('inbox'));
select pg_temp.c_assert((select jsonb_array_length(v->'items')=1 and v->'items'->0->>'kind'='assignment' and v->'items'->0->'comment_id'='null'::jsonb from comm_values where k='assignment'),'new assignment produces real private notice');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select public.tr8_v2_assign_task('d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000001',(select version from public.tr8_workspace_tasks where id='e9670000-0000-4000-8000-000000000001'),null);
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='0','former assignee no longer sees assignment notification');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select public.tr8_v2_assign_task('d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000001',(select version from public.tr8_workspace_tasks where id='e9670000-0000-4000-8000-000000000001'),'b9670000-0000-4000-8000-000000000002');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c('inbox')->'items')=1,'reassignment does not resurrect older assignment notice');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select public.tr8_v2_assign_task('d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000001',(select version from public.tr8_workspace_tasks where id='e9670000-0000-4000-8000-000000000001'),(select (v#>>'{}')::uuid from comm_values where k='owner_member'));
select pg_temp.c_assert(pg_temp.c('inbox')->>'unread_count'='0','self-assignment does not notify');

-- Real RPC creation exercises retention; no seed-only notification shortcuts.
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
do $$declare n integer;begin
 for n in 1..202 loop perform pg_temp.c('create',pg_temp.c_create(('c9670001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid));end loop;
end;$$;
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c('inbox')->'items')=200 and pg_temp.c('inbox')->>'unread_count'='200','inbox has strict latest-200 retention and visible count');
select pg_temp.c_assert(pg_temp.c('inbox')->'items'->0->>'comment_id'='c9670001-0000-4000-8000-000000000202','inbox newest order stable');
select pg_temp.c_assert(pg_temp.c('read_all')->>'updated'='200','mark all bounded to 200 recipient notices');
insert into comm_values values('dismiss_id',pg_temp.c('inbox')->'items'->0->'id');
select pg_temp.c_assert(pg_temp.c('dismiss',jsonb_build_object('id',(select v from comm_values where k='dismiss_id')))->>'dismissed'='true','dismiss affects own notice');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c('inbox')->'items')=199,'dismiss removes one notice');
select pg_temp.c_assert(pg_temp.c('dismiss',jsonb_build_object('id',(select v from comm_values where k='dismiss_id')))->>'dismissed'='true','lost dismiss acknowledgement replays safely');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
select pg_temp.c_assert(pg_temp.c('dismiss',jsonb_build_object('id',pg_temp.c_thread()->'items'->0->'id'))->>'dismissed'='true','unknown UUID acknowledges without existence oracle');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
insert into comm_values values('foreign_notice',pg_temp.c('inbox')->'items'->0->'id');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000002');
select pg_temp.c_assert(pg_temp.c('dismiss',jsonb_build_object('id',(select v from comm_values where k='foreign_notice')))->>'dismissed'='true','another recipient UUID reveals no existence');
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select pg_temp.c_assert(jsonb_array_length(pg_temp.c('inbox')->'items')=199,'other recipient dismiss cannot remove owner notice');

reset role;
insert into tr8_private.task_comments(id,workspace_id,task_id,author_id,body)
 select ('c9670002-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000004','f9670000-0000-4000-8000-000000000001','Quota fixture' from generate_series(1,500)n;
set local role authenticated;
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670002-0000-4000-8000-000000000501','e9670000-0000-4000-8000-000000000004'))$q$,'PT413','500 comment task cap enforced');
reset role;
insert into tr8_private.task_comments(id,workspace_id,task_id,author_id,body)
 select ('c9670003-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000002','f9670000-0000-4000-8000-000000000001','Workspace quota fixture'
 from generate_series(1,5000-(select count(*)::integer from tr8_private.task_comments where workspace_id='d9670000-0000-4000-8000-000000000001'))n;
set local role authenticated;
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670003-0000-4000-8000-000000009999'))$q$,'PT413','5000 comment workspace cap enforced');
reset role;
delete from tr8_private.task_comments where id::text like 'c9670003-%';
insert into tr8_private.comment_receipts(id,workspace_id,task_id,author_id,payload_hash)
 select ('c9670004-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d9670000-0000-4000-8000-000000000001','e9670000-0000-4000-8000-000000000002','f9670000-0000-4000-8000-000000000001',repeat('a',64)
 from generate_series(1,10000-(select count(*)::integer from tr8_private.comment_receipts where workspace_id='d9670000-0000-4000-8000-000000000001'))n;
set local role authenticated;
select pg_temp.c_error($q$select pg_temp.c('create',pg_temp.c_create('c9670004-0000-4000-8000-000000009999'))$q$,'PT413','permanent receipt cap enforced without dropping tombstones');

reset role;
select pg_temp.c_assert(not exists(select 1 from tr8_private.comment_reactions where comment_id='c9670000-0000-4000-8000-000000000020'),'delete cascades reactions');
select pg_temp.c_assert(not exists(select 1 from tr8_private.comment_mentions where comment_id='c9670000-0000-4000-8000-000000000020'),'delete cascades mentions');
select pg_temp.c_assert(not exists(select 1 from tr8_private.communication_notifications where comment_id='c9670000-0000-4000-8000-000000000020'),'delete cascades comment notifications');
select pg_temp.c_assert((select count(*)=0 from tr8_private.workspace_activity where workspace_id='d9670000-0000-4000-8000-000000000001' and action like 'comment.%' and affected_user_id is not null),'activity does not store mention recipient identities');
select pg_temp.c_assert(exists(select 1 from tr8_private.workspace_activity where workspace_id='d9670000-0000-4000-8000-000000000001' and action='comment.created') and exists(select 1 from tr8_private.workspace_activity where workspace_id='d9670000-0000-4000-8000-000000000001' and action='comment.updated') and exists(select 1 from tr8_private.workspace_activity where workspace_id='d9670000-0000-4000-8000-000000000001' and action='comment.deleted'),'create edit delete activity recorded minimally');
delete from public.tr8_workspace_tasks where id='e9670000-0000-4000-8000-000000000001';
select pg_temp.c_assert(not exists(select 1 from tr8_private.task_comments where task_id='e9670000-0000-4000-8000-000000000001'),'task delete cascades conversation');
select pg_temp.c_assert(not exists(select 1 from tr8_private.communication_notifications where task_id='e9670000-0000-4000-8000-000000000001'),'task delete cascades notification metadata');
select pg_temp.c_assert(exists(select 1 from tr8_private.comment_receipts where task_id='e9670000-0000-4000-8000-000000000001'),'task removal retains receipt identity');

set local role authenticated;
select pg_temp.c_actor('f9670000-0000-4000-8000-000000000001');
select pg_temp.c_error($q$select pg_temp.c('thread','{"task_id":"e9670000-0000-4000-8000-000000000004","before_id":null,"limit":50,"extra":true}')$q$,'22023','unknown thread key denied');
reset role;
delete from auth.sessions where user_id='f9670000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.c_error($q$select pg_temp.c('inbox')$q$,'42501','terminated session JWT cannot read inbox');
select pg_temp.c_error($q$select pg_temp.c_thread('e9670000-0000-4000-8000-000000000004')$q$,'42501','terminated session JWT cannot read conversation');
select pg_temp.c_actor(null);
select pg_temp.c_error($q$select pg_temp.c('inbox')$q$,'42501','missing actor denied');
reset role;
select pg_temp.c_assert((select hash from comm_existing where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where p.id=any((select ids from comm_existing where kind='projects')::uuid[])),'existing projects preserved');
select pg_temp.c_assert((select hash from comm_existing where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where t.id=any((select ids from comm_existing where kind='tasks')::uuid[])),'existing tasks preserved');
select pg_temp.c_assert((select hash from comm_existing where kind='finances')=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where f.owner_id=any((select ids from comm_existing where kind='finances')::uuid[])),'existing finances preserved');
select pg_temp.c_assert((select hash from comm_config)=(select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c),'signup and feature settings preserved');
select current_setting('tr8.communication_checks')::integer as passed_communication_checks;
rollback;
