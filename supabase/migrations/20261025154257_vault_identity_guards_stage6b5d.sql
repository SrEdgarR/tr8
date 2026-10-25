-- Narrow synthetic-only guards. An identity mutation may not silently bypass
-- the independent intent -> projection -> Auth sequence. No network in triggers.
create function tr8_vault_control.guard_identity() returns trigger
language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; state jsonb; permitted boolean:=false; begin
  if not exists(select 1 from tr8_vault_control.config where singleton and enabled) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_table_schema='auth' and tg_table_name='sessions' then actor:=old.user_id;
  elsif tg_table_schema='auth' then actor:=old.id;
  else actor:=old.user_id; end if;
  select p.state into state from tr8_vault_control.projection p where owner_id=actor;
  if not found then if tg_op='DELETE' then return old; else return new; end if; end if;
  if tg_table_schema='auth' and tg_table_name='sessions' then
    permitted:=not(state->'sessions' ? old.id::text) or state->'revokedSessions' ? old.id::text
      or state->>'status'<>'active' or floor(extract(epoch from old.created_at)*1000)<=(state->>'sessionCutoffMs')::bigint;
    if tg_op='UPDATE' and new.user_id=old.user_id and new.created_at is not distinct from old.created_at and new.not_after is not distinct from old.not_after then return new; end if;
  elsif tg_table_schema='auth' and tg_op='DELETE' then permitted:=state->>'status'='deleted';
  elsif tg_table_schema='auth' then
    if new.encrypted_password is not distinct from old.encrypted_password and new.email is not distinct from old.email and new.email_confirmed_at is not distinct from old.email_confirmed_at
      and new.banned_until is not distinct from old.banned_until and new.deleted_at is not distinct from old.deleted_at and new.is_anonymous is not distinct from old.is_anonymous then return new; end if;
    permitted:=state->>'status' in ('disabled','deleted') or (
      state->'sessions'='{}'::jsonb and (state->>'sessionCutoffMs')::bigint>=floor(extract(epoch from clock_timestamp()-interval '10 seconds')*1000)
      and exists(select 1 from tr8_vault_control.operations where owner_id=actor and intent->'next'=state and intent#>>'{command,kind}'='logout-all'));
  else
    if new.enabled or new.enabled is not distinct from old.enabled then return new; end if;
    permitted:=state->>'status' in ('disabled','deleted');
  end if;
  if not coalesce(permitted,false) then raise exception using errcode='PT403',message='COORDINATED_IDENTITY_CHANGE_REQUIRED'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end; $$;
revoke all on function tr8_vault_control.guard_identity() from public,anon,authenticated,service_role;
create trigger tr8_vault_session_guard before delete or update on auth.sessions for each row execute function tr8_vault_control.guard_identity();
create trigger tr8_vault_user_guard before delete or update on auth.users for each row execute function tr8_vault_control.guard_identity();
create trigger tr8_vault_app_identity_guard before update of enabled on tr8_private.app_users for each row execute function tr8_vault_control.guard_identity();
