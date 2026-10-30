-- Accept the dual-currency payment domain without rewriting any saved document.
-- CREATE OR REPLACE retains the existing authenticated-only ACL and session guards.
create or replace function tr8_private.account_finance(p_snapshot jsonb default null,p_expected_version text default null,p_operation_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); sid uuid; row tr8_private.account_finances; begin
 if actor is null then raise exception using errcode='42501',message='AUTH_REQUIRED'; end if;
 begin sid:=(auth.jwt()->>'session_id')::uuid; exception when others then raise exception using errcode='42501',message='AUTH_REQUIRED'; end;
 perform tr8_private.v5_require_session(actor,sid);
 -- Hold the actual session through commit so a concurrent logout cannot admit
 -- a late financial write. All account data remains restricted to auth.uid().
 perform 1 from auth.sessions where id=sid and user_id=actor for share;
 if not found then raise exception using errcode='42501',message='AUTH_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tr8-account-finance:'||actor::text,0));
 select * into row from tr8_private.account_finances where owner_id=actor for update;
 if p_snapshot is null then
  if p_expected_version is not null or p_operation_id is not null then raise exception using errcode='PT400',message='INVALID_INPUT'; end if;
  return jsonb_build_object('version',coalesce(row.version,0)::text,'snapshot',row.snapshot,'operationId',row.operation_id);
 end if;
 if p_expected_version is null or p_expected_version !~ '^(0|[1-9][0-9]{0,15})$' or p_expected_version::numeric>=9007199254740991 or p_operation_id is null
   or not tr8_finance.closed(p_snapshot,array['schemaVersion','financialSpace']) or p_snapshot->>'schemaVersion' is distinct from '1'
   or jsonb_typeof(p_snapshot->'financialSpace') is distinct from 'object' or coalesce(p_snapshot#>>'{financialSpace,domainSchemaVersion}','') not in ('4','5')
   or jsonb_typeof(p_snapshot#>'{financialSpace,accounts}') is distinct from 'array'
   or jsonb_typeof(p_snapshot#>'{financialSpace,operations}') is distinct from 'array'
   or jsonb_typeof(p_snapshot#>'{financialSpace,plans}') is distinct from 'array'
   or octet_length(p_snapshot::text)>2200000 then raise exception using errcode='PT400',message='INVALID_FINANCE_SNAPSHOT'; end if;
 if row.operation_id=p_operation_id then
  if row.snapshot is distinct from p_snapshot or row.version<>p_expected_version::bigint+1 then raise exception using errcode='PT409',message='OPERATION_CONFLICT'; end if;
  return jsonb_build_object('version',row.version::text,'snapshot',row.snapshot,'operationId',row.operation_id);
 end if;
 if coalesce(row.version,0)<>p_expected_version::bigint then raise exception using errcode='PT409',message='FINANCE_CONFLICT'; end if;
 -- An older client cannot silently discard the destination leg of an FX payment.
 if row.snapshot#>>'{financialSpace,domainSchemaVersion}'='5' and p_snapshot#>>'{financialSpace,domainSchemaVersion}'='4'
 then raise exception using errcode='PT400',message='INVALID_FINANCE_SNAPSHOT'; end if;
 insert into tr8_private.account_finances(owner_id,version,snapshot,operation_id)
 values(actor,p_expected_version::bigint+1,p_snapshot,p_operation_id)
 on conflict(owner_id) do update set version=excluded.version,snapshot=excluded.snapshot,operation_id=excluded.operation_id,updated_at=clock_timestamp()
 returning * into row;
 return jsonb_build_object('version',row.version::text,'snapshot',row.snapshot,'operationId',row.operation_id);
end; $$;
