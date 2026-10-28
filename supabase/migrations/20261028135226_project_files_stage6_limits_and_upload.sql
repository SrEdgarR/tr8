-- Storage performs an INSERT permission probe before streaming bytes. That
-- probe has contentLength/mimetype but no actual size. Its final caller-policy
-- probe carries measured size/mimetype before the managed write can commit.
-- Preserve all existing data and the original operation-aware policies.
begin;
lock table tr8_private.project_files,tr8_private.project_file_receipts in share row exclusive mode;
create temporary table tr8_files_correction_before on commit drop as select
 (select md5(coalesce(jsonb_agg(to_jsonb(f) order by id)::text,'')) from tr8_private.project_files f) files,
 (select md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'')) from tr8_private.project_file_receipts r) receipts;

-- Match client Unicode code-point length and require a basename before the
-- extension. Explicit C1 rejection does not depend on the database locale.
create or replace function tr8_private.project_file_fields(n text,c text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select n is not null and c is not null and length(n) between 1 and 180 and n=btrim(n)
  and n!~'[[:cntrl:]/\\]' and n!~('['||chr(127)||'-'||chr(159)||']') and n~'^.+\.[^.]+$' and
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

create or replace function tr8_private.project_file_storage_access(path text,mode text,object_metadata jsonb default null) returns boolean
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
 if f.status<>'pending' or f.created_by<>auth.uid() then return false;end if;
 -- Some managed preflight versions omit all object metadata. No client-facing
 -- SQL API may INSERT storage.objects: the policy also requires object.upload.
 -- The service rechecks its measured metadata after consuming the upload body.
 if object_metadata is null then return true;end if;
 if jsonb_typeof(object_metadata)<>'object' then return false;end if;
 if object_metadata?'mimetype' and object_metadata->>'mimetype' is distinct from f.content_type then return false;end if;
 if not(object_metadata?'size') then return true;end if;
 if jsonb_typeof(object_metadata->'size') is distinct from 'number'
  or coalesce(object_metadata->>'size','')!~'^[1-9][0-9]{0,6}$'
  or object_metadata->>'mimetype' is distinct from f.content_type then return false;end if;
 return (object_metadata->>'size')::bigint=f.size;
end;$$;

-- Bounded lifetime admission keeps minimal deletion tombstones permanently;
-- deleting a file releases bytes but never recycles its upload identifier.
-- Existing receipts are preserved, and their exact retries do not INSERT.
create function tr8_private.project_file_receipts_limit() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('tr8-project-files-budget',0));
 if (select count(*) from tr8_private.project_file_receipts)>=10000
 then raise exception using errcode='PT413',message='The file operation storage limit has been reached';end if;
 return new;
end;$$;
create trigger tr8_project_file_receipts_limit before insert on tr8_private.project_file_receipts
for each row execute function tr8_private.project_file_receipts_limit();
revoke all on function tr8_private.project_file_receipts_limit(),tr8_private.project_file_fields(text,text),tr8_private.project_file_storage_access(text,text,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function tr8_private.project_file_storage_access(text,text,jsonb) to authenticated;

do $$declare original record;begin
 select * into strict original from tr8_files_correction_before;
 if original.files is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by id)::text,'')) from tr8_private.project_files f)
  or original.receipts is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'')) from tr8_private.project_file_receipts r)
 then raise exception 'Files correction unexpectedly changed existing data';end if;
end;$$;
notify pgrst,'reload schema';
commit;
