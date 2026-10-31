-- Retire the canceled DOT financial MCP/OAuth attempt. The two applied rollout
-- migrations remain immutable. Existing finance snapshots, the encrypted vault,
-- projects, tasks, and shared project/task MCP credentials are not modified.
--
-- All checks and removals share one atomic statement. Exclusive locks close the
-- gap between checking for import/OAuth records and removing the unused feature.
-- If any durable import receipt or OAuth activity exists, abort without changes.
do $retire$
begin
  perform set_config('lock_timeout', '5s', true);
  lock table
    tr8_private.mcp_oauth_config,
    tr8_private.mcp_oauth_clients,
    tr8_private.mcp_oauth_attempts,
    tr8_private.mcp_oauth_grants,
    tr8_private.mcp_oauth_codes,
    tr8_private.mcp_oauth_access,
    tr8_private.mcp_oauth_refresh,
    tr8_private.mcp_finance_grants,
    tr8_private.mcp_finance_accounts,
    tr8_private.mcp_finance_notices,
    tr8_private.mcp_finance_messages,
    tr8_private.mcp_finance_requests
    in access exclusive mode;

  if exists (select 1 from tr8_private.mcp_finance_notices)
    or exists (select 1 from tr8_private.mcp_finance_messages)
    or exists (select 1 from tr8_private.mcp_finance_requests) then
    raise exception using errcode = '55000',
      message = 'Financial MCP retirement blocked: preserve existing import records and receipts';
  end if;
  if exists (select 1 from tr8_private.mcp_oauth_clients)
    or exists (select 1 from tr8_private.mcp_oauth_attempts)
    or exists (select 1 from tr8_private.mcp_oauth_grants)
    or exists (select 1 from tr8_private.mcp_oauth_codes)
    or exists (select 1 from tr8_private.mcp_oauth_access)
    or exists (select 1 from tr8_private.mcp_oauth_refresh) then
    raise exception using errcode = '55000',
      message = 'Financial MCP retirement blocked: preserve existing OAuth records';
  end if;
  if exists (
    select 1 from tr8_private.mcp_finance_grants
    where access <> 'read' or cardinality(mailbox_ids) <> 0
      or cardinality(expense_categories) <> 0 or cardinality(income_categories) <> 0
  ) then
    raise exception using errcode = '55000',
      message = 'Financial MCP retirement blocked: unexpected financial write or mailbox delegation';
  end if;

  drop function public.tr8_mcp_oauth_server(text, jsonb);
  drop function public.tr8_mcp_oauth_consent(text, jsonb);
  drop function public.tr8_mcp_oauth_finance_dispatch(text, text, jsonb);
  drop function public.tr8_mcp_finance_manage(text, jsonb);
  drop function public.tr8_mcp_finance_dispatch(text, text, jsonb);

  drop function tr8_private.mcp_oauth_server(text, jsonb);
  drop function tr8_private.mcp_oauth_consent(text, jsonb);
  drop function tr8_private.mcp_oauth_finance_dispatch(text, text, jsonb);
  drop function tr8_private.mcp_oauth_issue(tr8_private.mcp_oauth_grants, text[]);
  drop function tr8_private.mcp_oauth_grant(uuid);
  drop function tr8_private.mcp_oauth_parent(uuid);
  drop function tr8_private.mcp_oauth_client(text);
  drop function tr8_private.mcp_oauth_fingerprint(uuid);
  drop function tr8_private.mcp_oauth_require_config();
  drop function tr8_private.mcp_oauth_scopes(jsonb);
  drop function tr8_private.mcp_oauth_hash(text);
  drop function tr8_private.mcp_oauth_fail(text);
  drop function tr8_private.mcp_oauth_error(text);

  drop function tr8_private.mcp_finance_manage(text, jsonb);
  drop function tr8_private.mcp_finance_dispatch(text, text, jsonb);
  drop function tr8_private.mcp_finance_dispatch_credential(uuid, text, jsonb);
  drop function tr8_private.mcp_finance_grant_json(tr8_private.mcp_finance_grants);
  drop function tr8_private.mcp_finance_review_json(tr8_private.mcp_finance_notices);
  drop function tr8_private.mcp_finance_balance_safe(jsonb);
  drop function tr8_private.mcp_finance_require_capacity(uuid);
  drop function tr8_private.mcp_finance_decimal(numeric, integer);
  drop function tr8_private.mcp_finance_minor(text, integer);
  drop function tr8_private.mcp_finance_utc(timestamptz);
  drop function tr8_private.mcp_finance_instant(text);
  drop function tr8_private.mcp_finance_safe_text(text);
  drop function tr8_private.mcp_finance_text_ok(text);
  drop function tr8_private.mcp_finance_hash(jsonb);

  drop table tr8_private.mcp_oauth_codes;
  drop table tr8_private.mcp_oauth_access;
  drop table tr8_private.mcp_oauth_refresh;
  drop table tr8_private.mcp_oauth_grants;
  drop table tr8_private.mcp_oauth_attempts;
  drop table tr8_private.mcp_oauth_clients;
  drop table tr8_private.mcp_oauth_config;
  drop table tr8_private.mcp_finance_requests;
  drop table tr8_private.mcp_finance_messages;
  drop table tr8_private.mcp_finance_notices;
  drop table tr8_private.mcp_finance_accounts;
  drop table tr8_private.mcp_finance_grants;
end;
$retire$;

notify pgrst, 'reload schema';
