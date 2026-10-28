-- Reserve one full bucket-sized slot before each upload. Hosted Storage may
-- authorize before streaming without applying a second caller-policy size
-- check. Unconfirmed bytes therefore remain charged at the worst-case size.
-- The RPC still refuses to mark mismatched content ready or downloadable.
begin;
lock table tr8_private.project_files,tr8_private.project_file_receipts in share row exclusive mode;
create temporary table tr8_files_allocation_before on commit drop as select
 (select md5(coalesce(jsonb_agg(to_jsonb(f) order by id)::text,'')) from tr8_private.project_files f) files,
 (select md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'')) from tr8_private.project_file_receipts r) receipts;
alter table tr8_private.project_files add column allocated_bytes bigint not null default 5242880
 check(allocated_bytes between size and 5242880);
-- A formerly ready object already passed exact size/MIME validation. A pending
-- upload (also when deletion began at version 1) keeps its full 5 MiB slot.
update tr8_private.project_files set allocated_bytes=size
 where status='ready' or (status='deleting' and delete_from_version>1);

create or replace function tr8_private.project_file_json(r tr8_private.project_files) returns jsonb
language sql stable security invoker set search_path='' as $$
 select to_jsonb(r)-'delete_from_version'-'allocated_bytes';
$$;

create or replace function tr8_private.project_files(w uuid,a text,i jsonb) returns jsonb
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
   'used_bytes',(select coalesce(sum(q.allocated_bytes),0) from tr8_private.project_files q where q.workspace_id=w and q.project_id=p),
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
   or (select coalesce(sum(allocated_bytes),0) from tr8_private.project_files where workspace_id=w and project_id=p)+5242880>52428800
   or (select coalesce(sum(allocated_bytes),0) from tr8_private.project_files)+5242880>209715200
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
  update tr8_private.project_files set status='ready',allocated_bytes=size,version=version+1 where id=fid and version<999999999 returning * into f;
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

revoke all on function tr8_private.project_file_json(tr8_private.project_files),tr8_private.project_files(uuid,text,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function tr8_private.project_files(uuid,text,jsonb) to authenticated;
do $$declare original record;begin
 select * into strict original from tr8_files_allocation_before;
 if original.files is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f)-'allocated_bytes' order by id)::text,'')) from tr8_private.project_files f)
  or original.receipts is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'')) from tr8_private.project_file_receipts r)
 then raise exception 'File allocation unexpectedly changed existing content';end if;
end;$$;
notify pgrst,'reload schema';
commit;
