-- Reject control text the versioned client cannot represent safely. Existing
-- conversations are untouched; this strengthens only new/edited bodies.
begin;
create or replace function tr8_private.communication_body(b jsonb) returns text
language plpgsql immutable security invoker set search_path='' as $$
begin
 if b is null or jsonb_typeof(b)<>'string' or length(b#>>'{}') not between 1 and 4000
  or b#>>'{}'<>btrim(b#>>'{}') or b#>>'{}'~'^[[:space:]]*$'
  or b#>>'{}'~('['||chr(1)||'-'||chr(8)||chr(11)||chr(12)||chr(14)||'-'||chr(31)||chr(127)||'-'||chr(159)||']')
 then raise exception using errcode='22023',message='Comment must contain between 1 and 4000 valid characters';end if;
 return b#>>'{}';
end;$$;
revoke all on function tr8_private.communication_body(jsonb) from public,anon,authenticated,service_role;
commit;
