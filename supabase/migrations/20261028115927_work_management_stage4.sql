-- Demo parity stage 4: additive planning, task detail, safe cloning/moving/archive.
begin;
lock table public.tr8_workspace_projects,public.tr8_workspace_tasks,tr8_private.account_finances,tr8_private.app_config in share row exclusive mode;
create temporary table tr8_wm_before on commit drop as select
 (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p) projects,
 (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t) tasks,
 (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f) finances,
 (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c) config;

alter table public.tr8_workspace_projects
 add column start_date date,
 add column due_date date,
 add column lead_member_id uuid,
 add constraint tr8_project_planning_dates check(start_date is null or due_date is null or start_date<=due_date),
 add constraint tr8_project_lead_fk foreign key(workspace_id,lead_member_id) references tr8_private.workspace_members(workspace_id,id) on delete restrict;
create index tr8_projects_lead on public.tr8_workspace_projects(workspace_id,lead_member_id) where lead_member_id is not null;
alter table public.tr8_workspace_tasks
 add column labels jsonb not null default '[]',
 add column estimate_minutes integer check(estimate_minutes between 0 and 100000),
 add column subtasks jsonb not null default '[]',
 add column archived_at timestamptz;
create index tr8_tasks_active_by_project on public.tr8_workspace_tasks(workspace_id,project_id,id) where archived_at is null;

create function tr8_private.wm_details_valid(p_labels jsonb,p_estimate jsonb,p_subtasks jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare x jsonb; s text;
begin
 if p_labels is null or p_subtasks is null or p_estimate is null or jsonb_typeof(p_labels)<>'array' or jsonb_typeof(p_subtasks)<>'array' then return false;end if;
 if jsonb_array_length(p_labels)>10 or jsonb_array_length(p_subtasks)>100 or octet_length(p_subtasks::text)>50000 then return false;end if;
 if p_estimate<>'null'::jsonb and (jsonb_typeof(p_estimate)<>'number' or p_estimate::text!~'^[0-9]+$' or p_estimate::numeric>100000) then return false;end if;
 for x in select value from jsonb_array_elements(p_labels) loop
  if jsonb_typeof(x)<>'string' then return false;end if;s:=x#>>'{}';
  if s<>btrim(s) or length(s) not between 1 and 40 then return false;end if;
 end loop;
 if (select count(distinct lower(value)) from jsonb_array_elements_text(p_labels))<>jsonb_array_length(p_labels) then return false;end if;
 for x in select value from jsonb_array_elements(p_subtasks) loop
  if jsonb_typeof(x)<>'object' then return false;end if;
  if (select count(*) from jsonb_object_keys(x))<>3 or not(x ?& array['id','title','done'])
   or jsonb_typeof(x->'id')<>'string' or x->>'id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(x->'title')<>'string' or x->>'title'<>btrim(x->>'title') or length(x->>'title') not between 1 and 240
   or jsonb_typeof(x->'done')<>'boolean' then return false;end if;
 end loop;
 return (select count(distinct lower(value->>'id')) from jsonb_array_elements(p_subtasks))=jsonb_array_length(p_subtasks);
end;$$;
alter table public.tr8_workspace_tasks add constraint tr8_task_details_valid check(tr8_private.wm_details_valid(labels,coalesce(to_jsonb(estimate_minutes),'null'::jsonb),subtasks));

create table tr8_private.work_management_receipts (
 owner_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 request_id uuid not null,
 action text not null,
 payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),
 project_id uuid not null,
 task_id uuid references public.tr8_workspace_tasks(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,request_id),
 foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete cascade
);
create index tr8_wm_receipts_project on tr8_private.work_management_receipts(workspace_id,project_id);
create index tr8_wm_receipts_task on tr8_private.work_management_receipts(task_id) where task_id is not null;
create index tr8_wm_receipts_retention on tr8_private.work_management_receipts(owner_id,workspace_id,created_at desc);
alter table tr8_private.work_management_receipts enable row level security;
revoke all on tr8_private.work_management_receipts from public,anon,authenticated,service_role;

create function tr8_private.wm_project_input(i jsonb,p_creating boolean) returns void
language plpgsql immutable security invoker set search_path='' as $$
declare k text;
begin
 perform tr8_private.productivity_keys(i,case when p_creating then array['name','description','color','icon','status','start_date','due_date','lead_member_id','template_key'] else array['name','description','color','icon','status','start_date','due_date','lead_member_id'] end);
 if jsonb_typeof(i->'name')<>'string' or length(btrim(i->>'name')) not between 1 and 120
  or jsonb_typeof(i->'description')<>'string' or length(i->>'description')>10000
  or jsonb_typeof(i->'color')<>'string' or i->>'color'!~*'^#[0-9a-f]{6}$'
  or jsonb_typeof(i->'icon')<>'string' or i->>'icon'<>all(array['globe','smartphone','megaphone','rocket','component','building-2','layout-grid','palette','code','briefcase','target','layers','zap','heart','folder','sparkles'])
  or jsonb_typeof(i->'status')<>'string' or i->>'status'<>all(array['planning','active','hold','complete']) then raise exception using errcode='22023',message='Invalid project fields';end if;
 foreach k in array array['start_date','due_date'] loop
  if i->k<>'null'::jsonb and (jsonb_typeof(i->k)<>'string' or i->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then raise exception using errcode='22023',message='Invalid project date';end if;
 end loop;
 if (i->>'start_date')::date>(i->>'due_date')::date then raise exception using errcode='22023',message='Invalid project date range';end if;
 if i->'lead_member_id'<>'null'::jsonb and (jsonb_typeof(i->'lead_member_id')<>'string' or i->>'lead_member_id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception using errcode='22023',message='Invalid project lead';end if;
 if p_creating and i->'template_key'<>'null'::jsonb and (jsonb_typeof(i->'template_key')<>'string' or i->>'template_key'<>all(array['website','launch','sprint'])) then raise exception using errcode='22023',message='Unknown project template';end if;
end;$$;

create function tr8_private.wm_require_lead(w uuid,p uuid,m uuid) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if m is not null and not tr8_private.v2_assignee_eligible(w,p,m) then raise exception using errcode='22023',message='The project lead must be an active member with access to this project';end if;
end;$$;

create function tr8_private.wm_create_project(w uuid,p uuid,i jsonb) returns public.tr8_workspace_projects
language plpgsql volatile security invoker set search_path='' as $$
declare r public.tr8_workspace_projects;m uuid;
begin
 perform tr8_private.v2_require_workspace(w,'project.create');
 if not tr8_private.v2_has_permission(w,'project.read') then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if exists(select 1 from public.tr8_workspace_projects where id=p) then raise exception using errcode='PT409',message='The request identifier is unavailable';end if;
 insert into public.tr8_workspace_projects(id,workspace_id,owner_id,name,description,color,status,icon,start_date,due_date,lead_member_id)
 values(p,w,auth.uid(),btrim(i->>'name'),i->>'description',i->>'color',i->>'status',i->>'icon',(i->>'start_date')::date,(i->>'due_date')::date,(i->>'lead_member_id')::uuid) returning * into r;
 select id into m from tr8_private.workspace_members where workspace_id=w and user_id=auth.uid() and status='active';
 if m is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values(w,p,m,'write');
 if r.lead_member_id is not null then perform tr8_private.v2_require_project(w,p,'task.assign',true);end if;
 perform tr8_private.wm_require_lead(w,p,r.lead_member_id);
 insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id) values(w,p,auth.uid(),'project.created',p);
 return r;
end;$$;

create function tr8_private.wm_clone_task(w uuid,p uuid,n uuid,t public.tr8_workspace_tasks,p_copy_label boolean default true) returns public.tr8_workspace_tasks
language plpgsql volatile security invoker set search_path='' as $$
declare r public.tr8_workspace_tasks;
begin
 perform tr8_private.v2_require_project(w,p,'task.create',true);
 if exists(select 1 from public.tr8_workspace_tasks where id=n) then raise exception using errcode='PT409',message='The request identifier is unavailable';end if;
 insert into public.tr8_workspace_tasks(id,workspace_id,owner_id,project_id,title,description,status,priority,labels,estimate_minutes,subtasks)
 values(n,w,auth.uid(),p,case when p_copy_label then left(t.title,232)||' (copia)' else t.title end,t.description,'todo',t.priority,t.labels,t.estimate_minutes,
  coalesce((select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'title',s.value->>'title','done',false) order by s.ordinality) from jsonb_array_elements(t.subtasks) with ordinality s(value,ordinality)),'[]'::jsonb)) returning * into r;
 insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id) values(w,p,auth.uid(),'task.created',n);
 return r;
end;$$;

-- Retain the existing provenance, cleanup exception and version owner. Moving
-- is allowed only after live browser authorization on both project rows; there
-- is no client-controlled GUC or service-role bypass.
create or replace function tr8_private.guard_task()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_archived timestamptz;v_cleanup boolean:=false;v_restore boolean:=false;
begin
 if tg_op='INSERT' then
  new.created_at:=statement_timestamp();new.updated_at:=new.created_at;new.version:=1;
 else
  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id or new.owner_id is distinct from old.owner_id
   or new.task_number is distinct from old.task_number or new.created_at is distinct from old.created_at
   or new.updated_at is distinct from old.updated_at or new.version is distinct from old.version then raise exception using errcode='22023',message='Server-managed task fields are immutable';end if;
  if new.project_id is distinct from old.project_id then
   perform tr8_private.v7_require_browser_session();
   perform tr8_private.v2_require_project(old.workspace_id,old.project_id,'task.edit',true);
   perform tr8_private.v2_require_project(new.workspace_id,new.project_id,'task.create',true);
   if old.archived_at is not null then raise exception using errcode='PT409',message='Restore the archived task before moving it';end if;
   if old.assignee_member_id is distinct from new.assignee_member_id then perform tr8_private.v2_require_project(old.workspace_id,old.project_id,'task.assign',true);end if;
  end if;
  v_cleanup:=old.assignee_member_id is not null and new.assignee_member_id is null
   and (to_jsonb(new)-'assignee_member_id')=(to_jsonb(old)-'assignee_member_id')
   and not tr8_private.v2_assignee_eligible(old.workspace_id,old.project_id,old.assignee_member_id);
  v_restore:=old.archived_at is not null and new.archived_at is null and (to_jsonb(new)-'archived_at')=(to_jsonb(old)-'archived_at');
  if new.archived_at is distinct from old.archived_at then
   perform tr8_private.v7_require_browser_session();
   perform tr8_private.v2_require_project(old.workspace_id,old.project_id,'task.edit',true);
  end if;
  if old.archived_at is not null and not v_restore and not v_cleanup then raise exception using errcode='PT409',message='Restore the archived task before editing it';end if;
  new.version:=old.version+1;new.updated_at:=statement_timestamp();
 end if;
 select p.archived_at into v_archived from public.tr8_workspace_projects p where p.workspace_id=new.workspace_id and p.id=new.project_id for share;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if v_archived is not null and not v_cleanup then raise exception using errcode='PT409',message='Restore the archived project before editing its tasks';end if;
 if new.assignee_member_id is not null and not tr8_private.v2_assignee_eligible(new.workspace_id,new.project_id,new.assignee_member_id) then raise exception using errcode='22023',message='The assignee must be an active member able to read this project and its tasks';end if;
 new.title:=btrim(new.title);return new;
end;$$;

create function tr8_private.work_management(w uuid,a text,i jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare
 actor uuid:=auth.uid();id uuid;rid uuid;target uuid;old_project uuid;p public.tr8_workspace_projects;t public.tr8_workspace_tasks;copy_task public.tr8_workspace_tasks;
 r tr8_private.work_management_receipts;h text;outcome jsonb;member uuid;v integer;item jsonb;input jsonb;title text;n integer;include_tasks boolean;
begin
 perform tr8_private.v7_require_browser_session();
 perform tr8_private.v2_require_workspace(w,'project.read');
 if a<>all(array['create_project','update_project','duplicate_project','update_task_details','duplicate_task','move_task','archive_task']) or a is null then raise exception using errcode='22023',message='Unknown work management action';end if;
 if a='create_project' then perform tr8_private.productivity_keys(i,array['id','input']);rid:=(i->>'id')::uuid;
 elsif a='update_project' or a='update_task_details' then perform tr8_private.productivity_keys(i,array['id','version','input']);
 elsif a='duplicate_project' then perform tr8_private.productivity_keys(i,array['id','version','request_id','name','include_tasks']);rid:=(i->>'request_id')::uuid;
 elsif a='duplicate_task' then perform tr8_private.productivity_keys(i,array['id','version','target_project_id','request_id']);rid:=(i->>'request_id')::uuid;
 elsif a='move_task' then perform tr8_private.productivity_keys(i,array['id','version','target_project_id','request_id','clear_assignee']);rid:=(i->>'request_id')::uuid;
 else perform tr8_private.productivity_keys(i,array['id','version','archived','request_id']);rid:=(i->>'request_id')::uuid;end if;
 if jsonb_typeof(i->'id')<>'string' or i->>'id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='Invalid resource identifier';end if;
 id:=(i->>'id')::uuid;
 if a<>'create_project' then
  if jsonb_typeof(i->'version')<>'number' or i->>'version'!~'^[1-9][0-9]{0,8}$' then raise exception using errcode='22023',message='Expected version required';end if;v:=(i->>'version')::integer;
 end if;
 if a in ('create_project','update_project') then perform tr8_private.wm_project_input(i->'input',a='create_project');end if;
 if a='duplicate_project' and (jsonb_typeof(i->'name')<>'string' or length(btrim(i->>'name')) not between 1 and 120 or jsonb_typeof(i->'include_tasks')<>'boolean') then raise exception using errcode='22023',message='Invalid duplicate project input';end if;
 if a='archive_task' and jsonb_typeof(i->'archived')<>'boolean' then raise exception using errcode='22023',message='Invalid archive request';end if;
 if a='move_task' and jsonb_typeof(i->'clear_assignee')<>'boolean' then raise exception using errcode='22023',message='Invalid assignment choice';end if;
 if a in ('move_task','duplicate_task') then
  if jsonb_typeof(i->'target_project_id')<>'string' then raise exception using errcode='22023',message='Invalid destination';end if;target:=(i->>'target_project_id')::uuid;
 end if;
 if rid is not null and a<>'create_project' and jsonb_typeof(i->'request_id')<>'string' then raise exception using errcode='22023',message='Invalid request identifier';end if;
 if a in ('create_project','duplicate_project','duplicate_task','move_task','archive_task') and rid is null then raise exception using errcode='22023',message='Request identifier required';end if;
 -- All commands use the existing workspace authorization lock; project rows
 -- are locked in stable order before task rows or provider links.
 perform pg_advisory_xact_lock(hashtextextended('tr8-wm:'||actor::text||':'||w::text,0));
 h:=encode(extensions.digest(convert_to(jsonb_build_object('action',a,'input',i)::text,'UTF8'),'sha256'),'hex');
 if rid is not null then
  select * into r from tr8_private.work_management_receipts where owner_id=actor and workspace_id=w and request_id=rid;
  if found then
   if r.action<>a or r.payload_hash<>h then raise exception using errcode='PT409',message='Request identifier reused with different data';end if;
   -- A successful retry performs no new write. Authorize the current result,
   -- rather than requiring edit on its destination after a legitimate move.
   if r.task_id is null then
    perform tr8_private.v2_require_project(w,r.project_id,'project.read',false);
    select to_jsonb(q) into outcome from public.tr8_workspace_projects q where q.workspace_id=w and q.id=r.project_id for share;
   else
    select q.project_id into old_project from public.tr8_workspace_tasks q where q.workspace_id=w and q.id=r.task_id;
    if not found then raise exception using errcode='PT409',message='The result is no longer available';end if;
    perform tr8_private.v2_require_project(w,old_project,'task.read',false);
    perform 1 from public.tr8_workspace_projects q where q.workspace_id=w and q.id=old_project for share;
    select * into t from public.tr8_workspace_tasks q where q.workspace_id=w and q.id=r.task_id for share;
    if not found or t.project_id<>old_project then raise exception using errcode='PT409',message='The result moved. Reload before retrying';end if;
    outcome:=to_jsonb(t);
   end if;
   if outcome is null then raise exception using errcode='PT409',message='The result is no longer available';end if;return outcome;
  end if;
 end if;
 if a='create_project' then perform tr8_private.v2_require_workspace(w,'project.create');
 elsif a in ('update_project','duplicate_project') then
  perform tr8_private.v2_require_project(w,id,case when a='update_project' then 'project.edit' else 'project.read' end,a='update_project');
  select * into p from public.tr8_workspace_projects where workspace_id=w and public.tr8_workspace_projects.id=id for update;
 else
  select project_id into old_project from public.tr8_workspace_tasks where workspace_id=w and public.tr8_workspace_tasks.id=id;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  perform tr8_private.v2_require_project(w,old_project,case when a='duplicate_task' then 'task.read' else 'task.edit' end,a<>'duplicate_task');
  if target is not null then perform tr8_private.v2_require_project(w,target,'task.create',true);end if;
  perform 1 from public.tr8_workspace_projects q where q.workspace_id=w and q.id in (old_project,target) order by q.id for update;
  select * into t from public.tr8_workspace_tasks where workspace_id=w and public.tr8_workspace_tasks.id=id for update;
  if not found or t.project_id<>old_project then raise exception using errcode='PT409',message='The task moved. Reload it before saving';end if;
 end if;
 if a in ('update_project','duplicate_project') then
  if p.version<>v then raise exception using errcode='PT409',message='The project changed. Reload it before saving';end if;
  if p.archived_at is not null then raise exception using errcode='PT409',message='Restore the project before editing or copying it';end if;
 elsif a<>'create_project' then
  if t.version<>v then raise exception using errcode='PT409',message='The task changed. Reload it before saving';end if;
  if a<>'archive_task' and t.archived_at is not null then raise exception using errcode='PT409',message='Restore the task before editing or copying it';end if;
 end if;
 if a='create_project' then
  input:=i->'input';p:=tr8_private.wm_create_project(w,id,input);
  if input->>'template_key' is not null then
   perform tr8_private.v2_require_project(w,p.id,'task.create',true);
   for title in select value from jsonb_array_elements_text(case input->>'template_key'
    when 'website' then '["Definir alcance y estructura","Diseñar las pantallas","Construir el sitio","Revisar contenido y accesibilidad","Publicar y verificar"]'::jsonb
    when 'launch' then '["Definir objetivos del lanzamiento","Preparar los materiales","Revisar la entrega","Publicar el lanzamiento","Recoger resultados"]'::jsonb
    else '["Preparar el backlog","Planificar el sprint","Desarrollar la entrega","Validar los cambios","Revisar y hacer retrospectiva"]'::jsonb end) loop
    perform tr8_private.v2_create_task(w,gen_random_uuid(),p.id,title,'','todo','none',null,null);
   end loop;
  end if;
  outcome:=to_jsonb(p);
 elsif a='update_project' then
  input:=i->'input';
  if (input->>'lead_member_id')::uuid is distinct from p.lead_member_id then perform tr8_private.v2_require_project(w,id,'task.assign',true);end if;
  perform tr8_private.wm_require_lead(w,id,(input->>'lead_member_id')::uuid);
  update public.tr8_workspace_projects q set name=btrim(input->>'name'),description=input->>'description',color=input->>'color',status=input->>'status',icon=input->>'icon',
   start_date=(input->>'start_date')::date,due_date=(input->>'due_date')::date,lead_member_id=(input->>'lead_member_id')::uuid where q.workspace_id=w and q.id=id returning * into p;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id) values(w,id,actor,'project.updated',id);
  outcome:=to_jsonb(p);
 elsif a='duplicate_project' then
  include_tasks:=(i->>'include_tasks')::boolean;
  if include_tasks then
   perform tr8_private.v2_require_project(w,id,'task.read',false);
   select count(*) into n from public.tr8_workspace_tasks q where q.workspace_id=w and q.project_id=id and q.archived_at is null;
   if n>50 then raise exception using errcode='22023',message='A project copy supports up to 50 active tasks';end if;
  end if;
  input:=jsonb_build_object('name',btrim(i->>'name'),'description',p.description,'color',p.color,'status','planning','icon',p.icon,'start_date',null,'due_date',null,'lead_member_id',null);
  p:=tr8_private.wm_create_project(w,rid,input);
  if include_tasks then
   perform tr8_private.v2_require_project(w,p.id,'task.create',true);
   for copy_task in select * from public.tr8_workspace_tasks q where q.workspace_id=w and q.project_id=id and q.archived_at is null order by q.position,q.id for share loop
    perform tr8_private.wm_clone_task(w,p.id,gen_random_uuid(),copy_task,false);
   end loop;
  end if;
  outcome:=to_jsonb(p);
 elsif a='update_task_details' then
  input:=i->'input';perform tr8_private.productivity_keys(input,array['labels','estimate_minutes','subtasks']);
  if not tr8_private.wm_details_valid(input->'labels',input->'estimate_minutes',input->'subtasks') then raise exception using errcode='22023',message='Invalid task details';end if;
  update public.tr8_workspace_tasks q set labels=input->'labels',estimate_minutes=(input->>'estimate_minutes')::integer,subtasks=input->'subtasks' where q.workspace_id=w and q.id=id returning * into t;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id) values(w,t.project_id,actor,'task.updated',id);
  outcome:=to_jsonb(t);
 elsif a='duplicate_task' then
  t:=tr8_private.wm_clone_task(w,target,rid,t);outcome:=to_jsonb(t);
 elsif a='move_task' then
  if target=old_project then raise exception using errcode='22023',message='Choose another project';end if;
  member:=t.assignee_member_id;
  if (i->>'clear_assignee')::boolean and member is not null then perform tr8_private.v2_require_project(w,old_project,'task.assign',true);member:=null;end if;
  if member is not null and not tr8_private.v2_assignee_eligible(w,target,member) then raise exception using errcode='22023',message='Explicitly clear the assignee before moving to a project they cannot access';end if;
  update public.tr8_workspace_tasks q set project_id=target,assignee_member_id=member,position=(select coalesce(max(z.position),0)+1024 from public.tr8_workspace_tasks z where z.workspace_id=w and z.project_id=target)
   where q.workspace_id=w and q.id=id returning * into t;
  update tr8_private.productivity_favorites set project_id=target where workspace_id=w and task_id=id;
  update tr8_private.google_tasks_links set project_id=target where workspace_id=w and local_task_id=id and local_task_created_at=t.created_at;
  update tr8_private.google_event_links set project_id=target where workspace_id=w and task_id=id and task_created_at=t.created_at;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id) values(w,old_project,actor,'task.moved',id),(w,target,actor,'task.moved',id);
  outcome:=to_jsonb(t);
 else
  if (t.archived_at is not null)<>(i->>'archived')::boolean then
   update public.tr8_workspace_tasks q set archived_at=case when (i->>'archived')::boolean then clock_timestamp() else null end where q.workspace_id=w and q.id=id returning * into t;
   if t.archived_at is not null then
    -- Fence pending/in-flight work that still has access. Revocation cleanup is
    -- independent and remains allowed even if the local task is archived.
    update tr8_private.google_tasks_jobs j set state='cancelled',lease_token=null,lease_expires_at=null,reason='task_archived',finished_at=clock_timestamp()
     from tr8_private.google_tasks_links l where j.link_id=l.id and l.local_task_id=t.id and l.local_task_created_at=t.created_at
      and not l.cleanup_requested and tr8_private.v7_task_eligible(l.connection_id,t.id,t.created_at) and j.state in ('pending','retry','leased');
   else
    perform tr8_private.v6_enqueue(l.connection_id,case when l.remote_task_id is null then 'create' else 'patch' end,l.id,l.list_id)
     from tr8_private.google_tasks_links l join tr8_private.google_connections c on c.id=l.connection_id and c.generation=l.generation
     join tr8_private.google_tasks_sync s on s.connection_id=c.id and s.generation=c.generation and s.enabled
     where l.local_task_id=t.id and l.local_task_created_at=t.created_at and l.state not in ('deleted','retained','conflict') and not l.cleanup_requested
      and c.state='connected' and c.tasks_granted and tr8_private.v7_task_eligible(c.id,t.id,t.created_at);
   end if;
   insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id) values(w,t.project_id,actor,case when t.archived_at is null then 'task.restored' else 'task.archived' end,id);
  end if;
  outcome:=to_jsonb(t);
 end if;
 if rid is not null then
  insert into tr8_private.work_management_receipts(owner_id,workspace_id,request_id,action,payload_hash,project_id,task_id)
   values(actor,w,rid,a,h,(case when outcome?'task_number' then outcome->>'project_id' else outcome->>'id' end)::uuid,(case when outcome?'task_number' then outcome->>'id' end)::uuid);
  delete from tr8_private.work_management_receipts q where q.owner_id=actor and q.workspace_id=w and q.request_id in (
   select z.request_id from tr8_private.work_management_receipts z where z.owner_id=actor and z.workspace_id=w order by z.created_at desc,z.request_id desc offset 1000);
 end if;
 return outcome;
end;$$;

-- Calendar and provider archive semantics. These are complete definitions of
-- existing functions; their OIDs/ACLs and all unrelated behavior are retained.
create or replace function tr8_private.v3_calendar_tasks(p_scope jsonb)
returns table(task public.tr8_workspace_tasks,project_name text,project_color text,project_archived_at timestamptz,
  assignee_name text,workspace_name text,can_edit boolean)
language sql stable security definer set search_path = '' as $$
  select t,p.name,p.color,p.archived_at,a.display_name,w.name,
    p.archived_at is null and tr8_private.v2_has_permission(t.workspace_id,'task.edit')
      and (w.owner_id=(select auth.uid()) or exists(select 1 from tr8_private.workspace_members em
        join tr8_private.project_access ea on ea.workspace_id=em.workspace_id and ea.member_id=em.id
        where em.workspace_id=t.workspace_id and em.user_id=(select auth.uid()) and em.status='active'
          and ea.project_id=t.project_id and ea.access_level='write'))
  from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.workspace_id=t.workspace_id and p.id=t.project_id
    join tr8_private.workspaces w on w.id=t.workspace_id
    left join tr8_private.workspace_members m on m.workspace_id=t.workspace_id and m.id=t.assignee_member_id
    left join tr8_private.app_users a on a.user_id=m.user_id
  where t.workspace_id in(select x::uuid from jsonb_array_elements_text(p_scope->'workspaces') x)
    and t.archived_at is null
    and tr8_private.v2_can_read_project(t.workspace_id,t.project_id)
    and tr8_private.v2_has_permission(t.workspace_id,'task.read')
    and (p_scope->'projects'='null'::jsonb or t.project_id in(select x::uuid from jsonb_array_elements_text(coalesce(nullif(p_scope->'projects','null'::jsonb),'[]'::jsonb)) x))
    and (p_scope->'assignees'='null'::jsonb or t.assignee_member_id in(select x::uuid from jsonb_array_elements_text(coalesce(nullif(p_scope->'assignees','null'::jsonb),'[]'::jsonb)) x))
    and (p_scope->'statuses'='null'::jsonb or t.status in(select x from jsonb_array_elements_text(coalesce(nullif(p_scope->'statuses','null'::jsonb),'[]'::jsonb)) x))
    and ((p_scope->>'archived')::boolean or p.archived_at is null)
    -- Bound the candidate relation before materializing projection rows. The
    -- date-leading partial indexes serve these independent civil references.
    and ((p_scope->>'kind'='unscheduled' and t.scheduled_start_at is null and t.start_date is null and t.due_date is null)
      or (p_scope->>'kind'='calendar' and (
        (t.due_date>=(p_scope->>'from')::date and t.due_date<(p_scope->>'to')::date)
        or (t.scheduled_start_at is null and t.due_date is null and t.start_date>=(p_scope->>'from')::date and t.start_date<(p_scope->>'to')::date)
        or (t.scheduled_start_at<((p_scope->>'to')::date::timestamp at time zone (p_scope->>'zone'))
          and t.scheduled_end_at>((p_scope->>'from')::date::timestamp at time zone (p_scope->>'zone'))))))
    and (not (p_scope->>'mine')::boolean or (w.kind='personal' and w.owner_id=(select auth.uid()))
      or (w.kind='team' and m.user_id=(select auth.uid()) and m.status='active'));
$$;

create or replace function tr8_private.v5_task_eligible(p_connection uuid,p_task uuid,p_created timestamptz default null)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from tr8_private.google_connections c
    join public.tr8_workspace_tasks t on t.id=p_task
    join tr8_private.workspaces w on w.id=t.workspace_id
    left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=t.assignee_member_id and m.status='active'
    where t.archived_at is null and c.id=p_connection and c.state='connected'
      and (p_created is null or t.created_at=p_created)
      and not exists(select 1 from tr8_private.google_tasks_links l where l.local_task_id=t.id and l.local_task_created_at=t.created_at)
      and (t.scheduled_start_at is not null or t.due_date is not null or t.start_date is not null)
      and ((w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id))
      and tr8_private.v2_project_readable_for(w.id,t.project_id,c.user_id,true));
$$;

create or replace function tr8_private.v7_task_eligible(p_connection uuid,p_task uuid,p_created timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from tr8_private.google_connections c
    join public.tr8_workspace_tasks t on t.id=p_task and t.created_at=p_created
    join tr8_private.workspaces w on w.id=t.workspace_id
    join public.tr8_workspace_projects p on p.workspace_id=w.id and p.id=t.project_id and p.archived_at is null
    left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=t.assignee_member_id and m.status='active'
    where c.id=p_connection and tr8_private.v2_project_readable_for(w.id,p.id,c.user_id,true)
      and ((w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id)));
$$;

create or replace function tr8_private.v7_capture_new_task()
returns trigger language plpgsql security definer set search_path='' as $$
declare r record; v_link uuid; v_event record;
begin
  if new.archived_at is not null then return new;end if;
  if exists(select 1 from tr8_private.google_tasks_links where local_task_id=new.id and local_task_created_at=new.created_at and origin='google') then return new;end if;
  for r in select c.id,c.generation,s.export_list_id from tr8_private.google_connections c
    join tr8_private.google_tasks_sync s on s.connection_id=c.id and s.generation=c.generation and s.enabled and s.export_enabled
    join tr8_private.google_tasks_lists z on z.connection_id=c.id and z.generation=c.generation and z.list_id=s.export_list_id and z.selected
    join tr8_private.workspaces w on w.id=new.workspace_id
    join public.tr8_workspace_projects p on p.workspace_id=w.id and p.id=new.project_id and p.archived_at is null
    left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=new.assignee_member_id and m.status='active'
    where c.state='connected' and c.tasks_granted and c.credential_envelope is not null
      and s.export_enabled_at<=new.created_at
      and tr8_private.v2_project_readable_for(w.id,p.id,c.user_id,true)
      and ((w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id))
    order by c.id loop
    if exists(select 1 from tr8_private.google_tasks_links where connection_id=r.id and local_task_id=new.id and local_task_created_at=new.created_at) then continue;end if;
    insert into tr8_private.google_tasks_links(connection_id,generation,list_id,workspace_id,project_id,local_task_id,local_task_created_at,
      state,origin,creation_state,creation_marker)
      values(r.id,r.generation,r.export_list_id,new.workspace_id,new.project_id,new.id,new.created_at,'dirty','tr8','ready','tr8:'||gen_random_uuid())
      on conflict(connection_id,generation,local_task_id,local_task_created_at) do nothing returning id into v_link;
    if v_link is not null then
      -- Assignment is a separate UI RPC. An event from an earlier scan is
      -- retired by its exact identity before Tasks can post this new intent.
      for v_event in select id from tr8_private.google_event_links where connection_id=r.id and generation=r.generation
        and task_id=new.id and task_created_at=new.created_at and state not in ('deleted','retained') loop
        update tr8_private.google_event_links set state='deleting' where id=v_event.id;
        perform tr8_private.v5_enqueue(r.id,'delete',v_event.id);
      end loop;
      perform tr8_private.v6_enqueue(r.id,'create',v_link,r.export_list_id);
    end if;
  end loop;
  return new;
end; $$;

create or replace function tr8_private.v6_prepare(p_job uuid,p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_tasks_jobs; c tr8_private.google_connections; l tr8_private.google_tasks_links; v_local jsonb; v_result jsonb;
begin
  select * into j from tr8_private.google_tasks_jobs where id=p_job;
  if not found then return jsonb_build_object('valid',false);end if;
  select * into strict c from tr8_private.google_connections where id=j.connection_id for no key update;
  select * into j from tr8_private.google_tasks_jobs where id=p_job;
  if not found or j.state<>'leased' or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp()
    or c.generation<>j.generation or c.state<>'connected' or not c.tasks_granted or c.credential_envelope is null
    or not tr8_private.v2_user_live(c.user_id) or not exists(select 1 from tr8_private.app_users where user_id=c.user_id and enabled)
    or not exists(select 1 from tr8_private.google_tasks_sync s where s.connection_id=c.id and s.generation=c.generation and s.enabled)
    or (j.kind<>'discover' and not exists(select 1 from tr8_private.google_tasks_lists z where z.connection_id=c.id and z.generation=c.generation and z.list_id=j.list_id and z.selected)) then
    return jsonb_build_object('valid',false);
  end if;
  v_result:=jsonb_build_object('valid',true,'kind',j.kind,'connection_id',c.id,'user_id',c.user_id,'generation',c.generation,
    'calendar_id',c.calendar_id,'credential_envelope',c.credential_envelope,
    'time_zone',coalesce((select calendar_time_zone from tr8_private.app_users where user_id=c.user_id),'UTC'));
  if j.kind in ('discover','pull') then return v_result||jsonb_build_object('list_id',j.list_id,'page_token',j.page_token);end if;
  select * into l from tr8_private.google_tasks_links where id=j.link_id;
  if not found or l.connection_id<>c.id or l.generation<>c.generation or l.list_id is distinct from j.list_id then
    return jsonb_build_object('valid',false);
  end if;
  -- Archiving pauses Google Tasks without deleting or detaching either identity.
  -- Restore explicitly queues a fresh comparison; a stale lease cannot apply.
  if not l.cleanup_requested and tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at) and exists(select 1 from public.tr8_workspace_tasks t where t.id=l.local_task_id and t.created_at=l.local_task_created_at and t.archived_at is not null) then
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='task_archived',finished_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('valid',false);
  end if;
  if j.kind='create' then
    if l.origin<>'tr8' or l.creation_state not in ('ready','uncertain','bound') or l.state in ('deleted','retained','conflict') then
      update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='creation_inactive',finished_at=clock_timestamp() where id=j.id;
      return jsonb_build_object('valid',false);
    end if;
    if l.creation_state='ready' and exists(select 1 from tr8_private.google_event_links e
      where e.connection_id=c.id and e.task_id=l.local_task_id and e.task_created_at=l.local_task_created_at and e.state not in ('deleted','retained')) then
      return jsonb_build_object('valid',false);
    end if;
    -- Uncertain creates remain recoverable after local deletion or loss of
    -- access. Recovery attaches the ID and queues cleanup, never new content.
    if l.creation_state='ready' and (l.cleanup_requested or not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)) then
      update tr8_private.google_tasks_links set state='retained',creation_state='blocked',conflict_reason=null where id=l.id;
      update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='access_changed',finished_at=clock_timestamp() where id=j.id;
      return jsonb_build_object('valid',false);
    end if;
    return v_result||jsonb_build_object('list_id',j.list_id,'page_token',j.page_token,
      'link',jsonb_build_object('id',l.id,'remote_task_id',l.remote_task_id),'create_state',l.creation_state,
      'creation_marker',l.creation_marker,'creation_projection',l.creation_projection,'prepared_hash',l.creation_hash,
      'local',tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at));
  end if;
  if l.state in ('deleted','retained','conflict') then
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='link_inactive',finished_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('valid',false);
  end if;
  if l.origin='tr8' then
    if l.cleanup_requested or (tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is not null
      and not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)) then
      update tr8_private.google_tasks_links set cleanup_requested=true,state='deleting' where id=l.id;
    end if;
  elsif not exists(select 1 from tr8_private.workspaces w join public.tr8_workspace_projects p on p.workspace_id=w.id
    where w.id=l.workspace_id and w.kind='personal' and w.owner_id=c.user_id and p.id=l.project_id and p.archived_at is null) then
    update tr8_private.google_tasks_sync set reason='project_archived' where connection_id=c.id;
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='project_archived',finished_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('valid',false);
  end if;
  v_local:=tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at);
  return v_result||jsonb_build_object('list_id',j.list_id,'link',jsonb_build_object('id',l.id,'remote_task_id',l.remote_task_id),
    'local',case when v_local is null then null else v_local||jsonb_build_object('id',l.local_task_id) end,'previously_synced',true);
end; $$;

create or replace function tr8_private.v6_observe(p_connection uuid,p_list text,p_remote jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c tr8_private.google_connections; l tr8_private.google_tasks_links; t public.tr8_workspace_tasks;
  v_remote jsonb; v_local jsonb; v_remote_hash text; v_local_hash text; v_project jsonb;
  v_remote_changed boolean; v_local_changed boolean; v_deleted boolean; v_id uuid; v_created timestamptz;v_candidates bigint;v_adopt boolean:=false;
begin
  v_remote:=tr8_private.v6_remote_projection(p_remote);v_deleted:=v_remote is null;
  if coalesce((p_remote->>'assigned')::boolean,false) then return jsonb_build_object('action','none','skipped',true);end if;
  select * into strict c from tr8_private.google_connections where id=p_connection;
  select * into l from tr8_private.google_tasks_links where connection_id=c.id and generation=c.generation and list_id=p_list and remote_task_id=p_remote->>'id';
  if p_remote ? 'creation_marker' then
    if l.id is null then
      select * into l from tr8_private.google_tasks_links where connection_id=c.id and list_id=p_list and origin='tr8'
        and creation_marker=p_remote->>'creation_marker';
      if l.id is null then return jsonb_build_object('action','none','skipped',true);end if;
      -- An ordinary pull cannot prove that this marker occurs only once in
      -- the complete list. Quarantine it until dedicated paginated recovery.
      if not v_deleted and l.creation_state='bound' and l.remote_task_id=p_remote->>'id' then
        v_adopt:=l.generation<>c.generation;
      else
        if not v_deleted and l.creation_state<>'ready' and l.conflict_reason is distinct from 'creation_duplicate' then
          if l.creation_state='blocked' and l.remote_task_id is null then
            update tr8_private.google_tasks_links set creation_state='uncertain',state='dirty',conflict_reason=null,
              recovery_candidate=null,recovery_matches=0 where id=l.id;
          end if;
          if l.remote_task_id is null then
            update tr8_private.google_tasks_links set generation=c.generation where id=l.id;
            if not exists(select 1 from tr8_private.google_tasks_jobs where connection_id=c.id and generation=c.generation
              and link_id=l.id and kind='create' and state in ('pending','retry','leased')) then
              perform tr8_private.v6_enqueue(c.id,'create',l.id,p_list);
            end if;
          end if;
        end if;
        return jsonb_build_object('action','none','link_id',l.id,'skipped',true);
      end if;
    elsif l.origin='tr8' and l.creation_marker is distinct from p_remote->>'creation_marker' then
      return jsonb_build_object('action','none','skipped',true);
    end if;
  end if;
  if l.id is not null and not l.cleanup_requested and tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at) and exists(select 1 from public.tr8_workspace_tasks x where x.id=l.local_task_id and x.created_at=l.local_task_created_at and x.archived_at is not null) then
    return jsonb_build_object('action','none','link_id',l.id,'skipped',true,'reason','task_archived');
  end if;
  if l.id is not null and l.origin='tr8' then
    if l.cleanup_requested or (tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is not null
      and not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)) then
      update tr8_private.google_tasks_links set cleanup_requested=true,state=case when v_deleted then 'retained' else 'deleting' end,
        remote_projection=v_remote,remote_etag=p_remote->>'etag' where id=l.id;
      return jsonb_build_object('action',case when v_deleted then 'none' else 'delete' end,'link_id',l.id,'etag',p_remote->>'etag',
        'prepared_hash',null);
    end if;
  end if;
  if l.id is null and not v_deleted and p_list<>'@default' then
    -- A new grant proved access to the exact canonical resource path. Adopt
    -- its historical local identity, never a title match or another connection.
    select count(*) into v_candidates from tr8_private.google_tasks_links x
      join tr8_private.workspaces w on w.id=x.workspace_id and w.kind='personal' and w.owner_id=c.user_id
      where x.connection_id=c.id and x.list_id=p_list and x.remote_task_id=p_remote->>'id';
    if v_candidates>1 then
      update tr8_private.google_tasks_sync set reason='identity_conflict' where connection_id=c.id;
      return jsonb_build_object('action','conflict','reason','identity_conflict');
    elsif v_candidates=1 then
      select x.* into l from tr8_private.google_tasks_links x
        join tr8_private.workspaces w on w.id=x.workspace_id and w.kind='personal' and w.owner_id=c.user_id
        where x.connection_id=c.id and x.list_id=p_list and x.remote_task_id=p_remote->>'id';
      v_adopt:=true;
    end if;
  end if;
  if l.id is not null and not l.cleanup_requested and tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at) and exists(select 1 from public.tr8_workspace_tasks x where x.id=l.local_task_id and x.created_at=l.local_task_created_at and x.archived_at is not null) then
    return jsonb_build_object('action','none','link_id',l.id,'skipped',true,'reason','task_archived');
  end if;
  if l.id is null then
    if v_deleted then return jsonb_build_object('action','none','skipped',true);end if;
    v_project:=tr8_private.v6_ensure_import_project(c.id);
    perform tr8_private.v2_lock_workspace((v_project->>'workspace_id')::uuid);
    perform 1 from public.tr8_workspace_projects p where p.id=(v_project->>'project_id')::uuid and p.workspace_id=(v_project->>'workspace_id')::uuid and p.archived_at is null for share;
    if not found then return jsonb_build_object('action','none','skipped',true,'reason','project_archived');end if;
    v_id:=gen_random_uuid();v_created:=statement_timestamp();v_remote_hash:=tr8_private.v6_projection_hash(v_remote);
    insert into tr8_private.google_tasks_links(connection_id,generation,list_id,remote_task_id,workspace_id,project_id,local_task_id,local_task_created_at,
      remote_etag,remote_projection,base_projection_hash,synced_local_hash)
      values(c.id,c.generation,p_list,p_remote->>'id',(v_project->>'workspace_id')::uuid,(v_project->>'project_id')::uuid,v_id,v_created,
        p_remote->>'etag',v_remote,v_remote_hash,v_remote_hash) returning * into l;
    insert into public.tr8_workspace_tasks(id,workspace_id,project_id,owner_id,title,status,priority,start_date)
      values(v_id,l.workspace_id,l.project_id,c.user_id,v_remote->>'title',case when (v_remote->>'completed')::boolean then 'done' else 'todo' end,'none',(v_remote->>'start_date')::date);
    insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
      values(l.workspace_id,l.project_id,c.user_id,'google.tasks.imported',v_id);
    return jsonb_build_object('action','none','link_id',l.id,'imported',true);
  end if;
  -- Follow domain order: workspace -> project -> task -> link. A user editing a
  -- task must never deadlock against a worker holding its link first.
  perform tr8_private.v2_lock_workspace(l.workspace_id);
  perform 1 from tr8_private.workspaces w join public.tr8_workspace_projects p on p.workspace_id=w.id
    where w.id=l.workspace_id and p.id=l.project_id and p.archived_at is null
      and ((l.origin='google' and w.kind='personal' and w.owner_id=c.user_id)
        or (l.origin='tr8' and (tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)
          or tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is null))) for share of p;
  if not found then return jsonb_build_object('action','none','skipped',true,'reason','project_archived');end if;
  select * into t from public.tr8_workspace_tasks where id=l.local_task_id and created_at=l.local_task_created_at for update;
  if t.archived_at is not null and not l.cleanup_requested and tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at) then
    return jsonb_build_object('action','none','link_id',l.id,'skipped',true,'reason','task_archived');
  end if;
  v_local:=tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at);
  select * into strict l from tr8_private.google_tasks_links where id=l.id for update;
  if v_adopt then
    -- Acquire its domain rows before the link and jobs, just like a user edit.
    update tr8_private.google_tasks_links set generation=c.generation where id=l.id returning * into l;
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='superseded',finished_at=clock_timestamp()
      where link_id=l.id and generation<>c.generation and state in ('pending','retry','leased');
  end if;
  if l.state='retained' then return jsonb_build_object('action','none','skipped',true);end if;
  v_remote_hash:=tr8_private.v6_projection_hash(v_remote);v_local_hash:=tr8_private.v6_projection_hash(v_local);
  if l.resolution='local' and v_remote_hash is distinct from tr8_private.v6_projection_hash(l.remote_projection) then
    -- The choice covered the remote version displayed to the user, not a later
    -- edit made in Google while its resolution job was waiting.
    l.resolution:=null;
    update tr8_private.google_tasks_links set resolution=null where id=l.id;
  end if;
  v_remote_changed:=v_remote_hash is distinct from l.base_projection_hash;
  v_local_changed:=v_local_hash is distinct from l.synced_local_hash;
  update tr8_private.google_tasks_links set remote_etag=p_remote->>'etag',remote_projection=v_remote,updated_at=clock_timestamp() where id=l.id;
  if l.resolution='local' then
    if v_deleted and v_local is not null then
      update tr8_private.google_tasks_links set state='conflict',conflict_reason='remote_deleted',resolution=null where id=l.id;
      return jsonb_build_object('action','conflict','link_id',l.id);
    end if;
    return jsonb_build_object('action',case when v_local is null then 'delete' when v_deleted then 'conflict' else 'patch' end,'link_id',l.id,
      'etag',p_remote->>'etag','patch',case when v_local is null then null else jsonb_build_object('title',v_local->>'title','status',case when (v_local->>'completed')::boolean then 'completed' else 'needsAction' end,'due',v_local->>'start_date') end,
      'prepared_hash',v_local_hash);
  end if;
  if l.resolution<>'google' or l.resolution is null then
    if v_remote_changed and v_local_changed and v_remote_hash is distinct from v_local_hash then
      update tr8_private.google_tasks_links set state='conflict',conflict_reason=case when v_deleted then 'remote_deleted' else 'local_changed' end,resolution=null where id=l.id;
      return jsonb_build_object('action','conflict','link_id',l.id);
    end if;
    if not v_remote_changed and v_local_changed then
      if l.state='conflict' then return jsonb_build_object('action','conflict','link_id',l.id);end if;
      return jsonb_build_object('action',case when v_local is null then 'delete' else 'patch' end,'link_id',l.id,'etag',p_remote->>'etag',
        'patch',case when v_local is null then null else jsonb_build_object('title',v_local->>'title','status',case when (v_local->>'completed')::boolean then 'completed' else 'needsAction' end,'due',v_local->>'start_date') end,
        'prepared_hash',v_local_hash);
    end if;
  end if;
  if l.origin='tr8' and not (v_local is null and v_deleted) and v_remote_hash is distinct from v_local_hash
    and not tr8_private.v7_domain_permission(l.workspace_id,l.project_id,c.user_id,
      case when v_deleted then 'task.delete' when v_local is null then 'task.create' else 'task.edit' end) then
    update tr8_private.google_tasks_links set state='retained',conflict_reason='permission_changed',resolution=null where id=l.id;
    return jsonb_build_object('action','none','link_id',l.id,'skipped',true);
  end if;
  if v_deleted then
    update tr8_private.google_tasks_links set state='deleted',base_projection_hash=null,synced_local_hash=null,resolution=null,conflict_reason=null where id=l.id;
    if v_local is not null then
      delete from public.tr8_workspace_tasks where id=l.local_task_id and created_at=l.local_task_created_at;
      insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
        values(l.workspace_id,l.project_id,c.user_id,'google.tasks.deleted',l.local_task_id);
    end if;
    return jsonb_build_object('action','none','link_id',l.id,'deleted',v_local is not null);
  end if;
  if t.due_date is not null and (v_remote->>'start_date')::date>t.due_date then
    update tr8_private.google_tasks_links set state='conflict',conflict_reason='date_conflict',resolution=null where id=l.id;
    return jsonb_build_object('action','conflict','link_id',l.id);
  end if;
  -- Hash is recorded before domain triggers see the incoming projection. The
  -- internal outbox remains intact, while this known echo cannot enqueue PATCH.
  update tr8_private.google_tasks_links set state='synced',base_projection_hash=v_remote_hash,synced_local_hash=v_remote_hash,
    resolution=null,conflict_reason=null where id=l.id;
  if v_local is null then
    v_id:=gen_random_uuid();v_created:=statement_timestamp();
    update tr8_private.google_tasks_links set local_task_id=v_id,local_task_created_at=v_created where id=l.id;
    insert into public.tr8_workspace_tasks(id,workspace_id,project_id,owner_id,title,status,priority,start_date)
      values(v_id,l.workspace_id,l.project_id,c.user_id,v_remote->>'title',case when (v_remote->>'completed')::boolean then 'done' else 'todo' end,'none',(v_remote->>'start_date')::date);
  elsif v_local_hash is distinct from v_remote_hash then
    update public.tr8_workspace_tasks set title=v_remote->>'title',start_date=(v_remote->>'start_date')::date,
      status=case when (v_remote->>'completed')::boolean then 'done' when status='done' then 'todo' else status end
      where id=l.local_task_id and created_at=l.local_task_created_at;
  end if;
  return jsonb_build_object('action','none','link_id',l.id,'updated',v_local_hash is distinct from v_remote_hash);
end; $$;

-- Removing access also clears an ineligible descriptive project lead; it never grants access.
create or replace function tr8_private.v2_cleanup_assignments(p_workspace_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_task record;
begin
  -- Caller already holds the exclusive workspace lock. Follow project -> task
  -- order for every affected row, including archived projects, before writing.
  perform 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id
    and ((p.lead_member_id is not null and not tr8_private.v2_assignee_eligible(p.workspace_id,p.id,p.lead_member_id)) or exists(select 1 from public.tr8_workspace_tasks t where t.workspace_id=p.workspace_id and t.project_id=p.id
      and t.assignee_member_id is not null and not tr8_private.v2_assignee_eligible(t.workspace_id,t.project_id,t.assignee_member_id)))
    order by p.id for update;
  for v_task in select t.id,t.project_id,m.user_id from public.tr8_workspace_tasks t
    join tr8_private.workspace_members m on m.workspace_id=t.workspace_id and m.id=t.assignee_member_id
    where t.workspace_id=p_workspace_id and t.assignee_member_id is not null
      and not tr8_private.v2_assignee_eligible(t.workspace_id,t.project_id,t.assignee_member_id)
    order by t.id for update of t loop
    update public.tr8_workspace_tasks set assignee_member_id=null where id=v_task.id and workspace_id=p_workspace_id;
    insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id,affected_user_id)
      values(p_workspace_id,v_task.project_id,auth.uid(),'task.unassigned',v_task.id,v_task.user_id);
  end loop;
  for v_task in select p.id from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.lead_member_id is not null
    and not tr8_private.v2_assignee_eligible(p.workspace_id,p.id,p.lead_member_id) order by p.id for update loop
    update public.tr8_workspace_projects set lead_member_id=null where workspace_id=p_workspace_id and id=v_task.id;
    insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
      values(p_workspace_id,v_task.id,auth.uid(),'project.updated',v_task.id);
  end loop;
end;
$$;

-- Reordering covers active tasks only; archived rows keep their positions and versions.
create or replace function tr8_private.productivity(p_workspace_id uuid,p_action text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  a uuid:=auth.uid(); target uuid; parent uuid; p public.tr8_workspace_projects; v tr8_private.productivity_views;
  item jsonb; old_hash text; new_hash text; response jsonb; target_version integer; n integer; row_data public.tr8_workspace_tasks;
begin
  perform tr8_private.v7_require_browser_session();
  perform tr8_private.v2_require_workspace(p_workspace_id,'project.read');
  -- Serialize a user's preference quota and idempotent creation without locking anyone else's account.
  perform pg_advisory_xact_lock(hashtextextended('tr8-productivity:'||a::text||':'||p_workspace_id::text,0));
  if p_action='load' then
    perform tr8_private.productivity_keys(p_input,array[]::text[]);
    return jsonb_build_object(
      'favorites',coalesce((select jsonb_agg(jsonb_build_object('kind',f.kind,'id',f.id,'project_id',f.project_id) order by f.created_at,f.id)
        from tr8_private.productivity_favorites f where f.owner_id=a and f.workspace_id=p_workspace_id
          and tr8_private.v2_can_read_project(p_workspace_id,f.project_id)
          and (f.kind='project' or (tr8_private.v2_has_permission(p_workspace_id,'task.read') and exists(
            select 1 from public.tr8_workspace_tasks t where t.id=f.task_id and t.workspace_id=f.workspace_id and t.project_id=f.project_id)))),'[]'::jsonb),
      'views',coalesce((select jsonb_agg(tr8_private.productivity_view_json(vw) order by vw.created_at,vw.id)
        from tr8_private.productivity_views vw where vw.owner_id=a and vw.workspace_id=p_workspace_id
          and (vw.project_id is null or tr8_private.v2_can_read_project(p_workspace_id,vw.project_id))),'[]'::jsonb));
  elsif p_action='set_favorite' then
    perform tr8_private.productivity_keys(p_input,array['kind','id','favorite']);
    if jsonb_typeof(p_input->'kind')<>'string' or p_input->>'kind'<>all(array['project','task'])
      or jsonb_typeof(p_input->'id')<>'string' or jsonb_typeof(p_input->'favorite')<>'boolean' then
      raise exception using errcode='22023',message='Invalid favorite';end if;
    target:=(p_input->>'id')::uuid;
    if p_input->>'kind'='project' then parent:=target;
    else select t.project_id into parent from public.tr8_workspace_tasks t where t.id=target and t.workspace_id=p_workspace_id;end if;
    perform tr8_private.v2_require_project(p_workspace_id,parent,case when p_input->>'kind'='task' then 'task.read' else 'project.read' end,false);
    perform 1 from public.tr8_workspace_projects where id=parent and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
    if p_input->>'kind'='task' then
      perform 1 from public.tr8_workspace_tasks where id=target and workspace_id=p_workspace_id and project_id=parent for share;
      if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
    end if;
    if (p_input->>'favorite')::boolean then
      if not exists(select 1 from tr8_private.productivity_favorites where owner_id=a and workspace_id=p_workspace_id and kind=p_input->>'kind' and id=target)
        and (select count(*) from tr8_private.productivity_favorites where owner_id=a and workspace_id=p_workspace_id)>=1000 then
        raise exception using errcode='PT429',message='Favorite limit reached';end if;
      insert into tr8_private.productivity_favorites(owner_id,workspace_id,kind,id,project_id,task_id)
        values(a,p_workspace_id,p_input->>'kind',target,parent,case when p_input->>'kind'='task' then target end) on conflict do nothing;
    else delete from tr8_private.productivity_favorites where owner_id=a and workspace_id=p_workspace_id and kind=p_input->>'kind' and id=target;end if;
    return jsonb_build_object('kind',p_input->>'kind','id',target,'project_id',parent,'favorite',p_input->'favorite');
  elsif p_action='create_view' then
    perform tr8_private.productivity_keys(p_input,array['id','name','context','project_id','config']);
    if jsonb_typeof(p_input->'id')<>'string' or jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 80
      or jsonb_typeof(p_input->'context')<>'string' or p_input->>'context'<>all(array['tasks','mine','project'])
      or not ((p_input->>'context'='project' and jsonb_typeof(p_input->'project_id')='string') or (p_input->>'context'<>'project' and p_input->'project_id'='null'::jsonb))
      then raise exception using errcode='22023',message='Invalid saved view context';end if;
    target:=(p_input->>'id')::uuid;parent:=(p_input->>'project_id')::uuid;
    perform tr8_private.productivity_validate_config(p_input->'config');
    if parent is not null then perform tr8_private.v2_require_project(p_workspace_id,parent,'project.read',false);
      perform 1 from public.tr8_workspace_projects where id=parent and workspace_id=p_workspace_id for share;
      if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;end if;
    select * into v from tr8_private.productivity_views where id=target;
    if found then
      if v.owner_id<>a or v.workspace_id<>p_workspace_id or row(v.name,v.context,v.project_id,v.config) is distinct from row(btrim(p_input->>'name'),p_input->>'context',parent,p_input->'config') then
        raise exception using errcode='PT409',message='The request identifier is unavailable';end if;
      return tr8_private.productivity_view_json(v);
    end if;
    if (select count(*) from tr8_private.productivity_views where owner_id=a and workspace_id=p_workspace_id)>=50 then
      raise exception using errcode='PT429',message='Saved view limit reached';end if;
    insert into tr8_private.productivity_views(id,owner_id,workspace_id,context,project_id,name,config)
      values(target,a,p_workspace_id,p_input->>'context',parent,btrim(p_input->>'name'),p_input->'config') returning * into v;
    return tr8_private.productivity_view_json(v);
  elsif p_action in ('update_view','delete_view') then
    perform tr8_private.productivity_keys(p_input,case when p_action='update_view' then array['id','version','name','config'] else array['id','version'] end);
    if jsonb_typeof(p_input->'id')<>'string' or jsonb_typeof(p_input->'version')<>'number' or (p_input->>'version')!~'^[1-9][0-9]{0,8}$' then
      raise exception using errcode='22023',message='A saved view version is required';end if;
    target:=(p_input->>'id')::uuid;target_version:=(p_input->>'version')::integer;
    select * into v from tr8_private.productivity_views where id=target and owner_id=a and workspace_id=p_workspace_id for update;
    if not found then raise exception using errcode='PT404',message='Saved view unavailable';end if;
    if v.project_id is not null then perform tr8_private.v2_require_project(p_workspace_id,v.project_id,'project.read',false);end if;
    if v.version<>target_version then raise exception using errcode='PT409',message='Saved view changed. Reload it';end if;
    if p_action='delete_view' then
      delete from tr8_private.productivity_views where id=target;
      return jsonb_build_object('id',target,'deleted',true);
    end if;
    if jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 80 then raise exception using errcode='22023',message='Invalid saved view name';end if;
    perform tr8_private.productivity_validate_config(p_input->'config');
    update tr8_private.productivity_views set name=btrim(p_input->>'name'),config=p_input->'config',version=version+1,updated_at=clock_timestamp() where id=target returning * into v;
    return tr8_private.productivity_view_json(v);
  elsif p_action='reorder_tasks' then
    perform tr8_private.productivity_keys(p_input,array['project_id','request_id','items']);
    if jsonb_typeof(p_input->'items')<>'array' or jsonb_array_length(p_input->'items') not between 1 and 200
      or jsonb_typeof(p_input->'project_id')<>'string' or jsonb_typeof(p_input->'request_id')<>'string' then
      raise exception using errcode='22023',message='Reorder requires a complete project list of at most 200 tasks';end if;
    parent:=(p_input->>'project_id')::uuid;target:=(p_input->>'request_id')::uuid;
    perform tr8_private.v2_require_project(p_workspace_id,parent,'task.edit',true);
    select * into p from public.tr8_workspace_projects where id=parent and workspace_id=p_workspace_id for update;
    if p.archived_at is not null then raise exception using errcode='55000',message='Restore the project before reordering';end if;
    for item in select value from jsonb_array_elements(p_input->'items') loop
      perform tr8_private.productivity_keys(item,array['id','version','position']);
      if jsonb_typeof(item->'id')<>'string' or (item->>'id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(item->'version')<>'number' or (item->>'version')!~'^[1-9][0-9]{0,8}$'
        or jsonb_typeof(item->'position')<>'number' or (item->>'position')!~'^[0-9]{1,16}$'
        or (item->>'position')::numeric>9007199254740991 then raise exception using errcode='22023',message='Invalid reorder item';end if;
    end loop;
    n:=jsonb_array_length(p_input->'items');
    if (select count(distinct value->>'id') from jsonb_array_elements(p_input->'items'))<>n
      or (select count(distinct (value->>'position')::bigint) from jsonb_array_elements(p_input->'items'))<>n then
      raise exception using errcode='22023',message='Reorder items must be distinct';end if;
    if (select count(*) from public.tr8_workspace_tasks where workspace_id=p_workspace_id and project_id=parent and archived_at is null)<>n
      or exists(select 1 from jsonb_array_elements(p_input->'items') x where not exists(select 1 from public.tr8_workspace_tasks t where t.id=(x.value->>'id')::uuid and t.workspace_id=p_workspace_id and t.project_id=parent and t.archived_at is null)) then
      raise exception using errcode='PT409',message='The project task list changed. Reload it';end if;
    perform 1 from public.tr8_workspace_tasks where workspace_id=p_workspace_id and project_id=parent and archived_at is null order by id for update;
    new_hash:=encode(extensions.digest(convert_to((p_input->'items')::text,'UTF8'),'sha256'),'hex');
    select payload_hash into old_hash from tr8_private.productivity_reorders where owner_id=a and workspace_id=p_workspace_id and project_id=parent and request_id=target;
    if found then
      if old_hash<>new_hash then raise exception using errcode='PT409',message='The reorder request identifier was already used';end if;
    else
      if exists(select 1 from jsonb_array_elements(p_input->'items') x join public.tr8_workspace_tasks t on t.id=(x.value->>'id')::uuid where t.version<>(x.value->>'version')::integer) then
        raise exception using errcode='PT409',message='A task changed. Reload the project before reordering';end if;
      for item in select value from jsonb_array_elements(p_input->'items') order by value->>'id' loop
        select * into row_data from public.tr8_workspace_tasks where id=(item->>'id')::uuid;
        if row_data.position<>(item->>'position')::bigint then perform tr8_private.v2_update_task(p_workspace_id,row_data.id,row_data.version,jsonb_build_object('position',(item->>'position')::bigint));end if;
      end loop;
      insert into tr8_private.productivity_reorders(owner_id,workspace_id,project_id,request_id,payload_hash) values(a,p_workspace_id,parent,target,new_hash);
      delete from tr8_private.productivity_reorders where owner_id=a and workspace_id=p_workspace_id and (project_id,request_id) in
        (select project_id,request_id from tr8_private.productivity_reorders where owner_id=a and workspace_id=p_workspace_id order by created_at desc,request_id desc offset 1000);
    end if;
    select coalesce(jsonb_agg(to_jsonb(t) order by t.position,t.id),'[]'::jsonb) into response from public.tr8_workspace_tasks t where t.workspace_id=p_workspace_id and t.project_id=parent and t.archived_at is null;
    return response;
  end if;
  raise exception using errcode='22023',message='Unknown productivity action';
end;$$;

create function public.tr8_v2_work_management(p_workspace_id uuid,p_action text,p_input jsonb)
returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.work_management(p_workspace_id,p_action,p_input);$$;
revoke all on function tr8_private.wm_details_valid(jsonb,jsonb,jsonb),tr8_private.wm_project_input(jsonb,boolean),
 tr8_private.wm_require_lead(uuid,uuid,uuid),tr8_private.wm_create_project(uuid,uuid,jsonb),
 tr8_private.wm_clone_task(uuid,uuid,uuid,public.tr8_workspace_tasks,boolean),tr8_private.work_management(uuid,text,jsonb),public.tr8_v2_work_management(uuid,text,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function tr8_private.work_management(uuid,text,jsonb),public.tr8_v2_work_management(uuid,text,jsonb) to authenticated;

do $$declare before_row record;begin
 select * into strict before_row from tr8_wm_before;
 if before_row.projects is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p)-array['start_date','due_date','lead_member_id'] order by id)::text,'')) from public.tr8_workspace_projects p)
  or before_row.tasks is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(t)-array['labels','estimate_minutes','subtasks','archived_at'] order by id)::text,'')) from public.tr8_workspace_tasks t)
  or before_row.finances is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f)
  or before_row.config is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c)
 then raise exception 'Stage 4 unexpectedly changed existing data';end if;
end;$$;
notify pgrst,'reload schema';
commit;
