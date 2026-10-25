-- A revoked session must still receive its own invalidation hint until its JWT
-- expires. This metadata is never an authorization source or a ciphertext read.
create or replace function tr8_live.can_read_head(a uuid) returns boolean language sql stable security definer set search_path='' as $$
 select a=(select auth.uid()) and exists(select 1 from tr8_live.config c where c.singleton and c.owner_id=a);
$$;
alter table public.tr8_finance_heads add column revoked_session_id text;
create or replace function tr8_live.publish_head() returns trigger language plpgsql security definer set search_path='' as $$
declare revoked text; begin
 if tg_op='UPDATE' then
  select value into revoked from jsonb_array_elements_text(new.state->'revokedSessions') where not (old.state->'revokedSessions' ? value) limit 1;
 end if;
 insert into public.tr8_finance_heads(owner_id,sequence,session_epoch,operation_id,status,revoked_session_id)
 values(new.owner_id,new.state->>'sequence',new.state->>'sessionEpoch',new.state#>>'{head,operationId}',new.state->>'status',revoked)
 on conflict(owner_id) do update set sequence=excluded.sequence,session_epoch=excluded.session_epoch,operation_id=excluded.operation_id,status=excluded.status,revoked_session_id=excluded.revoked_session_id;
 return new;
end; $$;
