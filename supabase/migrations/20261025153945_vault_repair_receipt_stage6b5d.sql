-- Rebuild only a verified current-head receipt during quarantined repair.
do $$ declare definition text; before_fragment text:=$old$
    if p_expected->>'status'<>'active' then update tr8_private.app_users set enabled=false where user_id=p_actor; end if;
$old$; after_fragment text:=$new$
    if p_intent is not null and p_intent<>'null'::jsonb then
      if p_intent->>'status' is distinct from 'pending' or p_intent->'next' is distinct from p_expected
        or p_intent#>>'{command,kind}' is distinct from 'put'
        or p_intent#>>'{command,operationId}' is distinct from p_expected#>>'{head,operationId}'
        or p_intent->>'digest' is distinct from encode(sha256(convert_to(tr8_vault_control.stable(p_intent->'command'),'UTF8')),'hex') then raise exception using errcode='PT409',message='REPAIR_RECEIPT_MISMATCH'; end if;
      if exists(select 1 from tr8_vault_control.operations where owner_id=p_actor and operation_id=p_intent#>>'{command,operationId}' and intent is distinct from p_intent) then raise exception using errcode='PT409',message='REPAIR_RECEIPT_CONFLICT'; end if;
      insert into tr8_vault_control.operations values(p_actor,p_intent#>>'{command,operationId}',p_intent) on conflict do nothing;
    end if;
    if p_expected->>'status'<>'active' then update tr8_private.app_users set enabled=false where user_id=p_actor; end if;
$new$;
begin
 select pg_get_functiondef('tr8_vault_control.server(text,uuid,uuid,bigint,bigint,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,boolean)'::regprocedure) into definition;
 if position(before_fragment in definition)=0 then raise exception 'Unexpected repair definition'; end if;
 execute replace(definition,before_fragment,after_fragment);
end; $$;
