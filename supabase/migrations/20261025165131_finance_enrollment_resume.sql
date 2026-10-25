-- A freshly authenticated owner may finish an interrupted enrollment of their
-- still-live original session. No expired, revoked, cut-off or fabricated
-- original session can be admitted. The durable intent remains unchanged.
do $$ declare definition text; before_fragment text := $old$  if kind='enroll' then
    if c->>'actorSessionId' is distinct from p_session::text or (c->>'sessionCreatedAtMs')::bigint is distinct from created_ms or created_ms<=(local.state->>'sessionCutoffMs')::bigint
      or local.state->'sessions' ? p_session::text or local.state->'revokedSessions' ? p_session::text then raise exception using errcode='PT403',message='SESSION_REVOKED'; end if;
$old$; after_fragment text := $new$  if kind='enroll' then
    if not p_resume and c->>'actorSessionId' is distinct from p_session::text then raise exception using errcode='PT403',message='IDENTITY_MISMATCH'; end if;
    if not exists(select 1 from auth.sessions original where original.id::text=c->>'actorSessionId' and original.user_id=p_actor
      and floor(extract(epoch from original.created_at)*1000)::bigint=(c->>'sessionCreatedAtMs')::bigint
      and (original.not_after is null or original.not_after>clock_timestamp()))
      or (c->>'sessionCreatedAtMs')::bigint<=(local.state->>'sessionCutoffMs')::bigint
      or local.state->'sessions' ? (c->>'actorSessionId') or local.state->'revokedSessions' ? (c->>'actorSessionId') then raise exception using errcode='PT403',message='SESSION_REVOKED'; end if;
$new$;
begin
 select pg_get_functiondef('tr8_live.server(text,uuid,uuid,bigint,bigint,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,boolean,bigint)'::regprocedure) into definition;
 if position(before_fragment in definition)=0 then raise exception 'Unexpected enrollment definition'; end if;
 execute replace(definition,before_fragment,after_fragment);
end; $$;
