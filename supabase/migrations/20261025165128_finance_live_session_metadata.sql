-- Session closure never needs the private vault password or a recent login.
do $$ declare definition text; before_fragment text := $old$sensitive:=(kind<>'put' and not(kind='revoke' and c->>'targetSessionId'=p_session::text)) or local.envelope is null or local.envelope->>'keyEpoch' is distinct from p_envelope->>'keyEpoch' or local.envelope->>'credentialEpoch' is distinct from p_envelope->>'credentialEpoch' or p_resume;$old$;
after_fragment text := $new$sensitive:=(kind<>'put' and not(kind='revoke' and c->>'targetSessionId'=p_session::text)) or (kind='put' and (local.envelope is null or local.envelope->>'keyEpoch' is distinct from p_envelope->>'keyEpoch' or local.envelope->>'credentialEpoch' is distinct from p_envelope->>'credentialEpoch')) or p_resume;$new$;
begin
 select pg_get_functiondef('tr8_live.server(text,uuid,uuid,bigint,bigint,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,boolean,bigint)'::regprocedure) into definition;
 if position(before_fragment in definition)=0 then raise exception 'Unexpected live coordinator'; end if;
 execute replace(definition,before_fragment,after_fragment);
end; $$;

-- Realtime transmits only an invalidation hint. Every read still checks both
-- independent authorities and the live Auth session through the server.
create table public.tr8_finance_heads(owner_id uuid primary key,sequence text not null,session_epoch text not null,operation_id text,status text not null);
alter table public.tr8_finance_heads enable row level security;
revoke all on public.tr8_finance_heads from public,anon,authenticated,service_role;
grant select on public.tr8_finance_heads to authenticated;
create function tr8_live.can_read_head(a uuid) returns boolean language sql stable security definer set search_path='' as $$
 select a=(select auth.uid()) and exists(select 1 from tr8_live.config c join tr8_private.app_users u on u.user_id=c.owner_id where c.singleton and c.enabled and not c.quarantined and c.owner_id=a and u.enabled)
 and exists(select 1 from auth.sessions s where s.user_id=a and s.id::text=(select auth.jwt()->>'session_id') and (s.not_after is null or s.not_after>now()));
$$;
revoke all on function tr8_live.can_read_head(uuid) from public,anon,authenticated,service_role;
grant usage on schema tr8_live to authenticated;
grant execute on function tr8_live.can_read_head(uuid) to authenticated;
create policy finance_head_owner on public.tr8_finance_heads for select to authenticated using ((select auth.uid())=owner_id and tr8_live.can_read_head(owner_id));
create function tr8_live.publish_head() returns trigger language plpgsql security definer set search_path='' as $$ begin
 insert into public.tr8_finance_heads values(new.owner_id,new.state->>'sequence',new.state->>'sessionEpoch',new.state#>>'{head,operationId}',new.state->>'status')
 on conflict(owner_id) do update set sequence=excluded.sequence,session_epoch=excluded.session_epoch,operation_id=excluded.operation_id,status=excluded.status;
 return new;
end; $$;
revoke all on function tr8_live.publish_head() from public,anon,authenticated,service_role;
create trigger live_head_changed after insert or update of state on tr8_live.projection for each row execute function tr8_live.publish_head();
insert into public.tr8_finance_heads select owner_id,state->>'sequence',state->>'sessionEpoch',state#>>'{head,operationId}',state->>'status' from tr8_live.projection;
alter publication supabase_realtime add table public.tr8_finance_heads;

-- Operator-only negative receipt completion; never exposed as a browser route.
create function tr8_live.operator_receipt(p_owner uuid,p_operation text,p_authority uuid,p_case text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare cfg tr8_live.config; receipt jsonb; current_head tr8_live.projection; begin
 select * into cfg from tr8_live.config where singleton for update;
 if not cfg.enabled or cfg.authority_id is distinct from p_authority or cfg.case_id is distinct from p_case or cfg.owner_id is distinct from p_owner then raise exception using errcode='PT403',message='OPERATOR_RECOVERY_DISABLED'; end if;
 select intent into receipt from tr8_live.operations where owner_id=p_owner and operation_id=p_operation;
 if not found then return null; end if;
 if receipt#>>'{command,kind}' not in ('revoke','logout-all','disable','delete','reset') then raise exception using errcode='PT403',message='NEGATIVE_RECEIPT_REQUIRED'; end if;
 select * into current_head from tr8_live.projection where owner_id=p_owner for update;
 if not found or current_head.state is distinct from receipt->'next' then raise exception using errcode='PT409',message='RECEIPT_HEAD_MISMATCH'; end if;
 perform tr8_live.check_envelope(current_head.envelope,current_head.state->'head',p_owner);
 return receipt;
end; $$;
create function public.tr8_live_operator_receipt(p_owner uuid,p_operation text,p_authority uuid,p_case text) returns jsonb language sql volatile security invoker set search_path='' as $$ select tr8_live.operator_receipt(p_owner,p_operation,p_authority,p_case); $$;
revoke all on function tr8_live.operator_receipt(uuid,text,uuid,text),public.tr8_live_operator_receipt(uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function tr8_live.operator_receipt(uuid,text,uuid,text),public.tr8_live_operator_receipt(uuid,text,uuid,text) to service_role;
