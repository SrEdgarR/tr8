-- Demo parity stage 6: private, quota-reserved project files.
-- Storage object bytes and metadata are changed only through the Storage API.
-- No credentials, provider grants, existing content or signup flags are changed.
begin;
lock table public.tr8_workspace_projects,public.tr8_workspace_tasks,tr8_private.account_finances,tr8_private.app_config in share row exclusive mode;
create temporary table tr8_files_before on commit drop as select
 (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p) projects,
 (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t) tasks,
 (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f) finances,
 (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c) config;

create table tr8_private.project_files (
 id uuid primary key,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete restrict,
 project_id uuid not null,
 name text not null,
 content_type text not null,
 size bigint not null check(size between 1 and 5242880),
 status text not null default 'pending' check(status in('pending','ready','deleting')),
 object_path text not null unique,
 version integer not null default 1 check(version between 1 and 999999999),
 created_by uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 delete_from_version integer,
 check((status='deleting')=(delete_from_version is not null)),
 foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete restrict,
 check(object_path=workspace_id::text||'/'||project_id::text||'/'||id::text)
);
create index tr8_project_files_project on tr8_private.project_files(workspace_id,project_id,created_at,id);
-- Minimal permanent tombstones prevent reusing a deleted upload UUID. Their
-- digest contains no filename or content. Project removal preserves this guard.
create table tr8_private.project_file_receipts (
 id uuid primary key,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 project_id uuid not null,
 created_by uuid not null,
 payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 deleted_version integer,
 delete_from_version integer,
 check((deleted_version is null)=(delete_from_version is null))
);
create index tr8_project_file_receipts_workspace on tr8_private.project_file_receipts(workspace_id,project_id);
alter table tr8_private.project_files enable row level security;
alter table tr8_private.project_file_receipts enable row level security;
revoke all on tr8_private.project_files,tr8_private.project_file_receipts from public,anon,authenticated,service_role;

create function tr8_private.project_file_fields(n text,c text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select n is not null and c is not null and length(n) between 1 and 180 and n=btrim(n)
  and n!~'[[:cntrl:]/\\]' and n not in('.','..') and
  case c
   when 'image/png' then lower(n)~'\.png$'
   when 'image/jpeg' then lower(n)~'\.jpe?g$'
   when 'image/webp' then lower(n)~'\.webp$'
   when 'application/pdf' then lower(n)~'\.pdf$'
   when 'text/plain' then lower(n)~'\.txt$'
   when 'text/csv' then lower(n)~'\.csv$'
   when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then lower(n)~'\.docx$'
   when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then lower(n)~'\.xlsx$'
   when 'application/vnd.openxmlformats-officedocument.presentationml.presentation' then lower(n)~'\.pptx$'
   when 'application/zip' then lower(n)~'\.zip$'
   else false end;
$$;
create function tr8_private.project_file_json(r tr8_private.project_files) returns jsonb
language sql stable security invoker set search_path='' as $$
 select to_jsonb(r)-'delete_from_version';
$$;
create function tr8_private.project_files_lock_project(w uuid,p uuid,writing boolean) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare archived timestamptz;
begin
 perform tr8_private.v2_require_project(w,p,case when writing then 'project.edit' else 'project.read' end,writing);
 select archived_at into archived from public.tr8_workspace_projects where workspace_id=w and id=p for share;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if writing and archived is not null then raise exception using errcode='55000',message='Restore the archived project before changing files';end if;
end;$$;

create function tr8_private.project_files(w uuid,a text,i jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare
 actor uuid:=auth.uid();fid uuid;p uuid;v integer;n text;c text;bytes bigint;hash text;
 f tr8_private.project_files;r tr8_private.project_file_receipts;object_metadata jsonb;
begin
 perform tr8_private.v7_require_browser_session();
 perform tr8_private.v2_require_workspace(w,'project.read');
 if a is null or a<>all(array['list','reserve','complete','rename','begin_delete','finish_delete'])
 then raise exception using errcode='22023',message='Unknown project files action';end if;
 if i is null or jsonb_typeof(i)<>'object' or octet_length(i::text)>4000
 then raise exception using errcode='22023',message='Invalid project files input';end if;
 if a='list' then
  perform tr8_private.productivity_keys(i,array['project_id']);p:=tr8_private.planning_id(i->'project_id');
  perform tr8_private.project_files_lock_project(w,p,false);
  return jsonb_build_object('items',coalesce((select jsonb_agg(tr8_private.project_file_json(q) order by q.created_at desc,q.id)
    from tr8_private.project_files q where q.workspace_id=w and q.project_id=p),'[]'::jsonb),
   'used_bytes',(select coalesce(sum(q.size),0) from tr8_private.project_files q where q.workspace_id=w and q.project_id=p),
   'max_bytes',52428800,'max_file_bytes',5242880,'max_files',100);
 end if;
 if a='reserve' then
  perform tr8_private.productivity_keys(i,array['id','project_id','name','content_type','size']);
  p:=tr8_private.planning_id(i->'project_id');
  if jsonb_typeof(i->'name') is distinct from 'string' or jsonb_typeof(i->'content_type') is distinct from 'string'
   or not tr8_private.project_file_fields(i->>'name',i->>'content_type')
   or jsonb_typeof(i->'size') is distinct from 'number' or coalesce(i->>'size','')!~'^[1-9][0-9]{0,6}$'
  then raise exception using errcode='22023',message='Invalid file name, type or size';end if;
  bytes:=(i->>'size')::bigint;n:=i->>'name';c:=i->>'content_type';
  if bytes>5242880 then raise exception using errcode='22023',message='Files are limited to 5 MiB';end if;
 elsif a='rename' then
  perform tr8_private.productivity_keys(i,array['id','version','name']);v:=tr8_private.planning_version(i->'version');
  if jsonb_typeof(i->'name') is distinct from 'string' then raise exception using errcode='22023',message='Invalid file name';end if;
  n:=i->>'name';
 elsif a in('begin_delete','finish_delete') then
  perform tr8_private.productivity_keys(i,array['id','version']);v:=tr8_private.planning_version(i->'version');
 else perform tr8_private.productivity_keys(i,array['id']);end if;
 fid:=tr8_private.planning_id(i->'id');
 -- All quota/state mutations serialize globally across workspaces. Every
 -- reservation (also deleting) remains charged until API removal is confirmed.
 perform pg_advisory_xact_lock(hashtextextended('tr8-project-files-budget',0));
 if a='reserve' then
  perform tr8_private.project_files_lock_project(w,p,true);
  hash:=encode(extensions.digest(convert_to(i::text,'UTF8'),'sha256'),'hex');
  select * into r from tr8_private.project_file_receipts where id=fid;
  if found then
   if r.workspace_id<>w or r.project_id<>p or r.created_by<>actor or r.payload_hash<>hash
   then raise exception using errcode='PT409',message='The upload identifier is unavailable';end if;
   select * into f from tr8_private.project_files where id=fid;
   if not found or f.status='deleting' then raise exception using errcode='PT409',message='The upload was removed or is being removed';end if;
   return tr8_private.project_file_json(f);
  end if;
  if (select count(*) from tr8_private.project_files where workspace_id=w and project_id=p)>=100
   or (select coalesce(sum(size),0) from tr8_private.project_files where workspace_id=w and project_id=p)+bytes>52428800
   or (select coalesce(sum(size),0) from tr8_private.project_files)+bytes>209715200
  then raise exception using errcode='PT413',message='The project file storage limit has been reached';end if;
  insert into tr8_private.project_files(id,workspace_id,project_id,name,content_type,size,object_path,created_by)
  values(fid,w,p,n,c,bytes,w::text||'/'||p::text||'/'||fid::text,actor) returning * into f;
  insert into tr8_private.project_file_receipts(id,workspace_id,project_id,created_by,payload_hash) values(fid,w,p,actor,hash);
  return tr8_private.project_file_json(f);
 end if;
 select * into r from tr8_private.project_file_receipts where workspace_id=w and id=fid;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform tr8_private.project_files_lock_project(w,r.project_id,true);
 select * into f from tr8_private.project_files where workspace_id=w and id=fid for update;
 if not found then
  if a in('begin_delete','finish_delete') and r.deleted_version is not null
   and (v=r.deleted_version or (a='begin_delete' and v=r.delete_from_version))
  then return jsonb_build_object('id',fid,'deleted',true);end if;
  raise exception using errcode='PT404',message='Resource unavailable';
 end if;
 if a='complete' then
  if f.created_by<>actor then raise exception using errcode='PT404',message='Resource unavailable';end if;
  if f.status='deleting' then raise exception using errcode='55000',message='The file is being removed';end if;
  select metadata into object_metadata from storage.objects where bucket_id='tr8-project-files' and name=f.object_path;
  if not found then raise exception using errcode='55000',message='Upload is not complete';end if;
  if jsonb_typeof(object_metadata->'size') is distinct from 'number'
   or coalesce(object_metadata->>'size','')!~'^[1-9][0-9]{0,6}$'
   or (object_metadata->>'size')::bigint<>f.size or object_metadata->>'mimetype' is distinct from f.content_type
  then raise exception using errcode='22023',message='Uploaded file does not match its reservation';end if;
  if f.status='ready' then return tr8_private.project_file_json(f);end if;
  update tr8_private.project_files set status='ready',version=version+1 where id=fid and version<999999999 returning * into f;
  if not found then raise exception using errcode='PT409',message='File version exhausted';end if;
  return tr8_private.project_file_json(f);
 elsif a='rename' then
  if f.status<>'ready' then raise exception using errcode='55000',message='Only complete files may be renamed';end if;
  if not tr8_private.project_file_fields(n,f.content_type) then raise exception using errcode='22023',message='Keep the original file type when renaming';end if;
  update tr8_private.project_files set name=n,version=version+1 where id=fid and version=v and version<999999999 returning * into f;
  if not found then raise exception using errcode='PT409',message='This file changed. Reload before renaming';end if;
  return tr8_private.project_file_json(f);
 elsif a='begin_delete' then
  if f.status='deleting' and (v=f.version or v=f.delete_from_version) then return tr8_private.project_file_json(f);end if;
  update tr8_private.project_files set status='deleting',delete_from_version=version,version=version+1
   where id=fid and status<>'deleting' and version=v and version<999999999 returning * into f;
  if not found then raise exception using errcode='PT409',message='This file changed. Reload before deleting';end if;
  return tr8_private.project_file_json(f);
 else
  if f.status<>'deleting' or f.version<>v then raise exception using errcode='PT409',message='A current deletion ticket is required';end if;
  if exists(select 1 from storage.objects where bucket_id='tr8-project-files' and name=f.object_path)
  then raise exception using errcode='55000',message='Remove the Storage object before releasing its reservation';end if;
  update tr8_private.project_file_receipts set deleted_version=f.version,delete_from_version=f.delete_from_version where id=fid;
  delete from tr8_private.project_files where id=fid;
  return jsonb_build_object('id',fid,'deleted',true);
 end if;
end;$$;
create function public.tr8_v2_project_files(p_workspace_id uuid,p_action text,p_input jsonb default '{}') returns jsonb
language sql volatile security invoker set search_path='' as $$select tr8_private.project_files(p_workspace_id,p_action,p_input);$$;

-- The operation name comes from the managed Storage API, not client metadata.
-- Exact metadata comparison prevents reserving one byte and uploading 5 MiB.
create function tr8_private.project_file_storage_access(path text,mode text,object_metadata jsonb default null) returns boolean
language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare f tr8_private.project_files;
begin
 if path is null or mode is null or mode<>all(array['read','upload','delete']) then return false;end if;
 perform tr8_private.v7_require_browser_session();
 select * into f from tr8_private.project_files where object_path=path;
 if not found then return false;end if;
 perform tr8_private.project_files_lock_project(f.workspace_id,f.project_id,mode<>'read');
 select * into f from tr8_private.project_files where object_path=path for share;
 if not found then return false;end if;
 if mode='read' then return f.status='ready';end if;
 if mode='delete' then return f.status='deleting';end if;
 if f.status<>'pending' or f.created_by<>auth.uid() or jsonb_typeof(object_metadata->'size') is distinct from 'number'
  or coalesce(object_metadata->>'size','')!~'^[1-9][0-9]{0,6}$'
  or object_metadata->>'mimetype' is distinct from f.content_type then return false;end if;
 return (object_metadata->>'size')::bigint=f.size;
end;$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('tr8-project-files','tr8-project-files',false,5242880,array['image/png','image/jpeg','image/webp','application/pdf','text/plain','text/csv',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/vnd.openxmlformats-officedocument.presentationml.presentation','application/zip'])
on conflict(id) do nothing;
do $$begin
 if not exists(select 1 from storage.buckets where id='tr8-project-files' and name=id and not public and file_size_limit=5242880
  and allowed_mime_types=array['image/png','image/jpeg','image/webp','application/pdf','text/plain','text/csv',
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
   'application/vnd.openxmlformats-officedocument.presentationml.presentation','application/zip'])
 then raise exception 'Existing TR8 bucket configuration is incompatible';end if;
end;$$;
create policy tr8_project_files_insert on storage.objects for insert to authenticated with check(
 bucket_id='tr8-project-files' and storage.allow_only_operation('object.upload')
 and tr8_private.project_file_storage_access(name,'upload',metadata));
create policy tr8_project_files_select on storage.objects for select to authenticated using(
 bucket_id='tr8-project-files' and (
  (storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info','object.info_authenticated'])
   and tr8_private.project_file_storage_access(name,'read'))
  or (storage.allow_any_operation(array['object.delete','object.delete_many']) and tr8_private.project_file_storage_access(name,'delete'))));
create policy tr8_project_files_delete on storage.objects for delete to authenticated using(
 bucket_id='tr8-project-files' and storage.allow_any_operation(array['object.delete','object.delete_many'])
 and tr8_private.project_file_storage_access(name,'delete'));

-- Guard on TR8's own project table: foreign-key cascades cannot orphan bytes.
-- The UI must remove all ready files and incomplete reservations first.
create function tr8_private.project_files_before_project_delete() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 if exists(select 1 from tr8_private.project_files where workspace_id=old.workspace_id and project_id=old.id)
 then raise exception using errcode='PT422',message='Remove project files and pending uploads before deleting this project';end if;
 return old;
end;$$;
create trigger tr8_project_files_delete_guard before delete on public.tr8_workspace_projects
for each row execute function tr8_private.project_files_before_project_delete();

revoke all on function tr8_private.project_file_fields(text,text),tr8_private.project_file_json(tr8_private.project_files),
 tr8_private.project_files_lock_project(uuid,uuid,boolean),tr8_private.project_files(uuid,text,jsonb),
 tr8_private.project_file_storage_access(text,text,jsonb),tr8_private.project_files_before_project_delete(),
 public.tr8_v2_project_files(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function tr8_private.project_files(uuid,text,jsonb),public.tr8_v2_project_files(uuid,text,jsonb),
 tr8_private.project_file_storage_access(text,text,jsonb) to authenticated;
do $$declare original record;begin
 select * into strict original from tr8_files_before;
 if original.projects is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p)
  or original.tasks is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t)
  or original.finances is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f)
  or original.config is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c)
  or exists(select 1 from tr8_private.project_files) or exists(select 1 from tr8_private.project_file_receipts)
 then raise exception 'Project files stage 6 unexpectedly changed existing data';end if;
end;$$;
notify pgrst,'reload schema';
commit;
