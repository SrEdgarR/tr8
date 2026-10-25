-- Reapply independent identity facts on both normal updates and logical repair.
create function tr8_vault_control.enforce_identity() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
  update auth.refresh_tokens set revoked=true where session_id in (
    select id from auth.sessions where user_id=new.owner_id and (
      new.state->>'status'<>'active' or new.state->'revokedSessions' ? id::text
      or floor(extract(epoch from created_at)*1000)<=(new.state->>'sessionCutoffMs')::bigint));
  delete from auth.sessions where user_id=new.owner_id and (
    new.state->>'status'<>'active' or new.state->'revokedSessions' ? id::text
    or floor(extract(epoch from created_at)*1000)<=(new.state->>'sessionCutoffMs')::bigint);
  if new.state->>'status'<>'active' then update tr8_private.app_users set enabled=false where user_id=new.owner_id; end if;
  return new;
end; $$;
revoke all on function tr8_vault_control.enforce_identity() from public,anon,authenticated,service_role;
create trigger vault_control_identity after update of state on tr8_vault_control.projection for each row execute function tr8_vault_control.enforce_identity();
