-- Private metadata-only completion when the initiating Auth identity no longer exists.
create function tr8_vault_control.operator_receipt(p_owner uuid,p_operation text,p_authority uuid,p_case text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare cfg tr8_vault_control.config; receipt jsonb; current_head tr8_vault_control.projection; begin
  select * into cfg from tr8_vault_control.config where singleton for update;
  if not cfg.enabled or cfg.authority_id is distinct from p_authority or cfg.case_id is distinct from p_case
    or p_authority::text is distinct from 'c59d8b98-4cbf-4f74-a968-0c591a3d794a'
    or p_owner::text is distinct from '37848d70-989a-4f69-b124-0c959d8b49a6' then raise exception using errcode='PT403',message='OPERATOR_RECOVERY_DISABLED'; end if;
  select intent into receipt from tr8_vault_control.operations where owner_id=p_owner and operation_id=p_operation;
  if not found then return null; end if;
  if receipt#>>'{command,kind}' not in ('revoke','logout-all','disable','delete','reset') then raise exception using errcode='PT403',message='NEGATIVE_RECEIPT_REQUIRED'; end if;
  select * into current_head from tr8_vault_control.projection where owner_id=p_owner for update;
  if not found or current_head.state is distinct from receipt->'next' then raise exception using errcode='PT409',message='RECEIPT_HEAD_MISMATCH'; end if;
  perform tr8_vault_control.check_envelope(current_head.envelope,current_head.state->'head',p_owner);
  return receipt;
end; $$;
create function public.tr8_operator_vault_receipt(p_owner uuid,p_operation text,p_authority uuid,p_case text)
returns jsonb language sql volatile security invoker set search_path='' as $$ select tr8_vault_control.operator_receipt(p_owner,p_operation,p_authority,p_case); $$;
revoke all on function tr8_vault_control.operator_receipt(uuid,text,uuid,text),public.tr8_operator_vault_receipt(uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function tr8_vault_control.operator_receipt(uuid,text,uuid,text),public.tr8_operator_vault_receipt(uuid,text,uuid,text) to service_role;
