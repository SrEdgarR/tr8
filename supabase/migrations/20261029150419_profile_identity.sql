-- Personal display names are editable through an account-bound, session-checked
-- endpoint. No data, Auth claims, roles, workspaces or grants on tables change.
begin;
create function tr8_private.profile_identity(p_name text,p_expected_updated_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); profile tr8_private.app_users; next_name text;
begin
  perform tr8_private.v7_require_browser_session();
  perform tr8_private.v2_require_actor();
  if (p_name is null)<>(p_expected_updated_at is null) then
    raise exception using errcode='22023',message='Name and expected profile revision must be supplied together';
  end if;
  if p_name is null then
    select * into profile from tr8_private.app_users where user_id=actor and enabled for share;
  else
    if p_name~'[[:cntrl:]]' or char_length(btrim(p_name)) not between 1 and 120
      or not isfinite(p_expected_updated_at) then
      raise exception using errcode='22023',message='A display name must contain one to one hundred twenty characters without control characters';
    end if;
    next_name:=btrim(p_name);
    select * into profile from tr8_private.app_users where user_id=actor and enabled for update;
  end if;
  if not found then raise exception using errcode='42501',message='This account is not authorized';end if;
  if p_name is not null and profile.display_name is distinct from next_name then
    if profile.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode='PT409',message='This profile changed. Reload it before changing the display name';
    end if;
    update tr8_private.app_users set display_name=next_name,
      updated_at=greatest(clock_timestamp(),profile.updated_at+interval '1 microsecond')
      where user_id=actor and enabled returning * into profile;
  end if;
  -- Replays of the same name return its current revision without another write.
  -- The browser-session and enabled-account checks apply to reads and replays.
  perform tr8_private.v7_require_browser_session();
  perform tr8_private.v2_require_actor();
  return jsonb_build_object('user_id',profile.user_id,'display_name',profile.display_name,'updated_at',profile.updated_at);
end;$$;
create function public.tr8_v2_profile(p_name text default null,p_expected_updated_at timestamptz default null)
returns jsonb language sql volatile security invoker set search_path='' as $$
  select tr8_private.profile_identity(p_name,p_expected_updated_at);
$$;
revoke all on function tr8_private.profile_identity(text,timestamptz),public.tr8_v2_profile(text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function tr8_private.profile_identity(text,timestamptz),public.tr8_v2_profile(text,timestamptz) to authenticated;
notify pgrst,'reload schema';
commit;
