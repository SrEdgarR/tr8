-- A historical receipt is insufficient after a partial logical restore.
-- Preserve the already-applied function, signature and ACL; add a current-head fence.
do $$ declare definition text; before_fragment text:=$old$
    select intent into result from tr8_vault_control.operations where owner_id=p_actor and operation_id=p_operation_id;
    return result;
$old$; after_fragment text:=$new$
    select intent into result from tr8_vault_control.operations where owner_id=p_actor and operation_id=p_operation_id;
    if result is not null then
      select * into local from tr8_vault_control.projection where owner_id=p_actor for update;
      if not found or local.state is distinct from result->'next' then raise exception using errcode='PT409',message='RECEIPT_HEAD_MISMATCH'; end if;
      perform tr8_vault_control.check_envelope(local.envelope,local.state->'head',p_actor);
    end if;
    return result;
$new$;
begin
  select pg_get_functiondef('tr8_vault_control.server(text,uuid,uuid,bigint,bigint,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,boolean)'::regprocedure) into definition;
  if position(before_fragment in definition)=0 then raise exception 'Unexpected coordinator definition; refusing to patch'; end if;
  execute replace(definition,before_fragment,after_fragment);
end; $$;
