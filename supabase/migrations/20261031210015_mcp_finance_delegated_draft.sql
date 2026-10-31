-- DRAFT ONLY: no credentials or grants are created and no existing financial
-- snapshot, encrypted vault, registration policy or browser-session guard changes.
-- Apply only after review/approval. Finance delegation is an explicit extra grant.
create table tr8_private.mcp_finance_grants (
 credential_id uuid primary key references tr8_private.mcp_credentials(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 access text not null check(access in ('read','write')),
 mailbox_ids text[] not null check(cardinality(mailbox_ids) between 0 and 20 and (access='read' or cardinality(mailbox_ids)>=1)),
 expense_categories text[] not null,
 income_categories text[] not null,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create index mcp_finance_grants_owner on tr8_private.mcp_finance_grants(owner_id,credential_id);
create table tr8_private.mcp_finance_accounts (
 credential_id uuid not null references tr8_private.mcp_finance_grants(credential_id) on delete cascade,
 account_id text not null check(octet_length(account_id) between 1 and 128 and account_id=btrim(account_id)),
 start_at timestamptz not null check(isfinite(start_at)),
 primary key(credential_id,account_id)
);
-- Durable deduplication identities belong to the user, NOT the disposable agent
-- credential. Revocation/rotation, deleting a movement or restoring a snapshot
-- cannot erase these receipts and silently re-create old bank movements.
create table tr8_private.mcp_finance_notices (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 account_id text not null,
 kind text not null,
 bank_status text not null,
 bank_reference_hash text,
 financial_hash text not null check(financial_hash ~ '^[a-f0-9]{64}$'),
 canonical jsonb not null,
 status text not null check(status in ('recorded','review','dismissed')),
 review_reason text,
 operation_id uuid,
 result jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(owner_id,id),
 check((status='recorded')=(operation_id is not null))
);
create unique index mcp_finance_bank_reference on tr8_private.mcp_finance_notices(owner_id,account_id,bank_reference_hash)
 where bank_reference_hash is not null;
create index mcp_finance_review_owner on tr8_private.mcp_finance_notices(owner_id,id) where status='review';
create table tr8_private.mcp_finance_messages (
 owner_id uuid not null references auth.users(id) on delete cascade,
 mailbox_id text not null check(mailbox_id ~ '^[a-f0-9]{64}$'),
 message_id text not null check(message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 notice_id uuid not null,
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 primary key(owner_id,mailbox_id,message_id),
 foreign key(owner_id,notice_id) references tr8_private.mcp_finance_notices(owner_id,id) on delete restrict
);
create index mcp_finance_messages_notice on tr8_private.mcp_finance_messages(owner_id,notice_id);
create table tr8_private.mcp_finance_requests (
 owner_id uuid not null references auth.users(id) on delete cascade,
 request_id uuid not null,
 notice_id uuid not null,
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 result jsonb not null,
 primary key(owner_id,request_id),
 foreign key(owner_id,notice_id) references tr8_private.mcp_finance_notices(owner_id,id) on delete restrict
);
create index mcp_finance_requests_notice on tr8_private.mcp_finance_requests(owner_id,notice_id);
alter table tr8_private.mcp_finance_grants enable row level security;
alter table tr8_private.mcp_finance_accounts enable row level security;
alter table tr8_private.mcp_finance_notices enable row level security;
alter table tr8_private.mcp_finance_messages enable row level security;
alter table tr8_private.mcp_finance_requests enable row level security;
revoke all on tr8_private.mcp_finance_grants,tr8_private.mcp_finance_accounts,tr8_private.mcp_finance_notices,
 tr8_private.mcp_finance_messages,tr8_private.mcp_finance_requests from public,anon,authenticated,service_role;

create function tr8_private.mcp_finance_hash(value jsonb) returns text
language sql immutable security invoker set search_path='' as $$select encode(sha256(convert_to(value::text,'UTF8')),'hex');$$;
create function tr8_private.mcp_finance_text_ok(value text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select value is not null and value !~* '(bearer[[:space:]]+[^[:space:]]+|tr8_mcp_|sb_secret_|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\m(otp|pin|cvv|cvc|password|contrase[nñ]a|c[oó]digo de (acceso|seguridad|verificaci[oó]n))\M.{0,20}[0-9]{3,})';
$$;
-- Existing manual ledger text predates the notice input guard. Redact the
-- projected MCP response only; never overwrite the user's original snapshot.
create function tr8_private.mcp_finance_safe_text(value text) returns text
language sql immutable security invoker set search_path='' as $$
 select case when not tr8_private.mcp_finance_text_ok(cleaned) then '[omitido]'
  else regexp_replace(cleaned,'([0-9][ -]?){8,}','[omitido]','g') end
 from (select regexp_replace(regexp_replace(value,'[[:cntrl:]]',' ','g'),U&'[\202A-\202E\2066-\2069\200E\200F]','','g') cleaned)q;
$$;
-- Hard storage budgets preserve the Free plan without expiring deduplication
-- history. Called only while holding the per-owner financial transaction lock.
create function tr8_private.mcp_finance_require_capacity(actor uuid) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if exists(select 1 from tr8_private.mcp_finance_notices where owner_id=actor offset 9999 limit 1)
  or exists(select 1 from tr8_private.mcp_finance_messages where owner_id=actor offset 19999 limit 1)
  or exists(select 1 from tr8_private.mcp_finance_requests where owner_id=actor offset 29999 limit 1)
 then raise exception using errcode='PT429',message='Finance integration storage budget reached'; end if;
end;$$;
create function tr8_private.mcp_finance_instant(value text) returns timestamptz
language plpgsql stable security invoker set search_path='' as $$
declare t timestamptz;
begin
 if value is null or value !~ '^\d{4}-\d{2}-\d{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
 then raise exception using errcode='22023',message='Invalid instant'; end if;
 t:=value::timestamptz;
 if not isfinite(t) or extract(year from t at time zone 'UTC') not between 1 and 9999
 then raise exception using errcode='22023',message='Invalid instant'; end if;
 return t;
end;$$;

create function tr8_private.mcp_finance_manage(p_action text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=auth.uid(); c tr8_private.mcp_credentials; g tr8_private.mcp_finance_grants; n tr8_private.mcp_finance_notices;
 s jsonb; item jsonb; ids text[]; expenses text[]; incomes text[]; mailboxes text[]; result jsonb; cursor_id uuid; page_size integer;
begin
 perform tr8_private.v2_require_actor();
 perform tr8_private.v7_require_browser_session();
 if p_action is null or p_action not in ('list','set_grant','revoke_grant','list_reviews','dismiss_review') or p_input is null or octet_length(p_input::text)>32768 then raise exception using errcode='22023',message='Invalid management arguments'; end if;
 if p_action='list' then
  perform tr8_private.mcp_keys(p_input,array[]::text[]);
  return jsonb_build_object('items',coalesce((select jsonb_agg(tr8_private.mcp_finance_grant_json(x) order by x.credential_id)
   from tr8_private.mcp_finance_grants x where x.owner_id=actor),'[]'::jsonb),'next_cursor',null);
 elsif p_action='list_reviews' then
  perform tr8_private.mcp_keys(p_input,array['cursor','limit']);
  cursor_id:=(p_input->>'cursor')::uuid; page_size:=coalesce((p_input->>'limit')::integer,50);
  if page_size not between 1 and 100 or (p_input?'limit' and (jsonb_typeof(p_input->'limit')<>'number' or p_input->>'limit' !~ '^[0-9]+$')) then raise exception using errcode='22023',message='Invalid page'; end if;
  with page as (select x.* from tr8_private.mcp_finance_notices x where x.owner_id=actor and x.status='review'
   and (cursor_id is null or x.id>cursor_id) order by x.id limit page_size+1), visible as (select * from page order by id limit page_size)
  select jsonb_build_object('items',coalesce((select jsonb_agg(tr8_private.mcp_finance_review_json(v::tr8_private.mcp_finance_notices) order by v.id) from visible v),'[]'::jsonb),
   'next_cursor',case when (select count(*) from page)>page_size then (select id from visible order by id desc limit 1)::text else null end,
   'version',coalesce((select version::text from tr8_private.account_finances where owner_id=actor),'0')) into result;
  return result;
 elsif p_action='dismiss_review' then
  perform tr8_private.mcp_keys(p_input,array['notice_id'],array['notice_id']);
  perform pg_advisory_xact_lock(hashtextextended('tr8-account-finance:'||actor::text,0));
  update tr8_private.mcp_finance_notices set status='dismissed' where owner_id=actor and id=(p_input->>'notice_id')::uuid and status in ('review','dismissed') returning * into n;
  if not found then raise exception using errcode='PT404',message='Review unavailable'; end if;
  return tr8_private.mcp_finance_review_json(n);
 elsif p_action not in ('set_grant','revoke_grant') then raise exception using errcode='22023',message='Unknown management action'; end if;
 if p_action='revoke_grant' then perform tr8_private.mcp_keys(p_input,array['credential_id'],array['credential_id']);
 else perform tr8_private.mcp_keys(p_input,array['credential_id','access','accounts','mailbox_ids','expense_categories','income_categories'],array['credential_id','access','accounts','mailbox_ids','expense_categories','income_categories']); end if;
 select * into c from tr8_private.mcp_credentials where id=(p_input->>'credential_id')::uuid and owner_id=actor;
 if not found then raise exception using errcode='PT404',message='Connection unavailable'; end if;
 perform tr8_private.v2_lock_workspace(c.workspace_id);
 select * into c from tr8_private.mcp_credentials where id=c.id and owner_id=actor for update;
 if p_action='revoke_grant' then
  delete from tr8_private.mcp_finance_grants where credential_id=c.id and owner_id=actor;
  return jsonb_build_object('credential_id',c.id,'enabled',false);
 end if;
 if c.revoked_at is not null or c.expires_at<=clock_timestamp() or not exists(select 1 from tr8_private.workspaces where id=c.workspace_id and kind='personal' and owner_id=actor)
  or not exists(select 1 from tr8_private.workspace_members where workspace_id=c.workspace_id and user_id=actor and status='active')
 then raise exception using errcode='PT403',message='Finance requires the owner personal connection'; end if;
 if p_input->>'access' not in ('read','write') or jsonb_typeof(p_input->'access')<>'string'
  or jsonb_typeof(p_input->'accounts')<>'array' or jsonb_array_length(p_input->'accounts') not between 1 and 100
  or jsonb_typeof(p_input->'mailbox_ids')<>'array' or jsonb_array_length(p_input->'mailbox_ids') not between 0 and 20
  or (p_input->>'access'='write' and jsonb_array_length(p_input->'mailbox_ids')=0)
  or jsonb_typeof(p_input->'expense_categories')<>'array' or jsonb_array_length(p_input->'expense_categories')>8
  or jsonb_typeof(p_input->'income_categories')<>'array' or jsonb_array_length(p_input->'income_categories')>7
 then raise exception using errcode='22023',message='Invalid finance grant'; end if;
 if exists(select 1 from jsonb_array_elements(p_input->'mailbox_ids')x where jsonb_typeof(x)<>'string' or x#>>'{}' !~ '^[a-f0-9]{64}$')
  or exists(select 1 from jsonb_array_elements(p_input->'expense_categories')x where jsonb_typeof(x)<>'string' or x#>>'{}'<>all(array['food','transport','home','health','leisure','shopping','services','other']))
  or exists(select 1 from jsonb_array_elements(p_input->'income_categories')x where jsonb_typeof(x)<>'string' or x#>>'{}'<>all(array['salary','freelance','business','investment','gift','refund','other']))
 then raise exception using errcode='22023',message='Invalid allowed categories or mailboxes'; end if;
 mailboxes:=array(select jsonb_array_elements_text(p_input->'mailbox_ids'));
 expenses:=array(select jsonb_array_elements_text(p_input->'expense_categories')); incomes:=array(select jsonb_array_elements_text(p_input->'income_categories'));
 if cardinality(mailboxes)<>(select count(distinct x) from unnest(mailboxes)x)
  or cardinality(expenses)<>(select count(distinct x) from unnest(expenses)x) or cardinality(incomes)<>(select count(distinct x) from unnest(incomes)x)
 then raise exception using errcode='22023',message='Duplicate grant values'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tr8-account-finance:'||actor::text,0));
 select snapshot into s from tr8_private.account_finances where owner_id=actor;
 ids:=array[]::text[];
 for item in select value from jsonb_array_elements(p_input->'accounts') loop
  perform tr8_private.mcp_keys(item,array['account_id','start_at'],array['account_id','start_at']);
  if jsonb_typeof(item->'account_id')<>'string' or octet_length(item->>'account_id') not between 1 and 128 or item->>'account_id'<>btrim(item->>'account_id')
   or jsonb_typeof(item->'start_at')<>'string' or item->>'account_id'=any(ids)
   or not exists(select 1 from jsonb_array_elements(s#>'{financialSpace,accounts}')x where x->>'id'=item->>'account_id')
  then raise exception using errcode='22023',message='Invalid granted account'; end if;
  perform tr8_private.mcp_finance_instant(item->>'start_at'); ids:=array_append(ids,item->>'account_id');
 end loop;
 insert into tr8_private.mcp_finance_grants(credential_id,owner_id,access,mailbox_ids,expense_categories,income_categories)
 values(c.id,actor,p_input->>'access',mailboxes,expenses,incomes)
 on conflict(credential_id) do update set access=excluded.access,mailbox_ids=excluded.mailbox_ids,expense_categories=excluded.expense_categories,income_categories=excluded.income_categories,updated_at=clock_timestamp() returning * into g;
 delete from tr8_private.mcp_finance_accounts where credential_id=c.id;
 insert into tr8_private.mcp_finance_accounts(credential_id,account_id,start_at)
 select c.id,value->>'account_id',tr8_private.mcp_finance_instant(value->>'start_at') from jsonb_array_elements(p_input->'accounts');
 return tr8_private.mcp_finance_grant_json(g);
end;$$;
create function tr8_private.mcp_finance_utc(value timestamptz) returns text
language sql stable security invoker set search_path='' as $$select to_char(value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');$$;
create function tr8_private.mcp_finance_minor(value text,digits integer) returns numeric
language plpgsql immutable security invoker set search_path='' as $$
declare n numeric; fraction text;
begin
 if value is null or length(value)>100 or value !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' or digits not between 0 and 6
 then raise exception using errcode='22023',message='Invalid amount'; end if;
 fraction:=substring(value from '[.,]([0-9]+)$');
 if length(coalesce(fraction,''))>digits then raise exception using errcode='22023',message='Invalid precision'; end if;
 n:=replace(value,',','.')::numeric*power(10::numeric,digits);
 if n<>trunc(n) or n<=0 or n>9007199254740991 then raise exception using errcode='22023',message='Invalid amount'; end if;
 return n;
end;$$;
create function tr8_private.mcp_finance_decimal(value numeric,digits integer) returns text
language sql immutable security invoker set search_path='' as $$
 select case when digits=0 then trunc(value)::text else trunc(value/power(10::numeric,digits))::text||'.'||lpad(trunc(mod(abs(value),power(10::numeric,digits)))::text,digits,'0') end;
$$;
create function tr8_private.mcp_finance_grant_json(g tr8_private.mcp_finance_grants) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('credential_id',g.credential_id,'enabled',true,'access',g.access,'mailbox_ids',to_jsonb(g.mailbox_ids),
 'expense_categories',to_jsonb(g.expense_categories),'income_categories',to_jsonb(g.income_categories),'accounts',
 coalesce((select jsonb_agg(jsonb_build_object('account_id',a.account_id,'start_at',tr8_private.mcp_finance_utc(a.start_at)) order by a.account_id)
 from tr8_private.mcp_finance_accounts a where a.credential_id=g.credential_id),'[]'::jsonb));
$$;
create function tr8_private.mcp_finance_review_json(n tr8_private.mcp_finance_notices) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('notice_id',n.id,'status',n.status,'review_reason',n.review_reason,'account_id',n.account_id,
 'kind',n.kind,'bank_status',n.bank_status,'amount',n.canonical->'amount','currency',n.canonical->'currency','date',n.canonical->'date',
 'occurred_at',n.canonical->'occurred_at','time_zone',n.canonical->'time_zone','description',n.canonical->'description',
 'category',n.canonical->'category','created_at',tr8_private.mcp_finance_utc(n.created_at));
$$;

-- Same safe-integer/day-closing guard as domain/balance-range.ts. The append
-- never rewrites another operation, account, plan, card baseline or schema version.
create function tr8_private.mcp_finance_balance_safe(snapshot jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare a jsonb; o jsonb; amount numeric; defs jsonb; safe boolean;
begin
 perform tr8_private.mcp_keys(snapshot,array['schemaVersion','financialSpace'],array['schemaVersion','financialSpace']);
 perform tr8_private.mcp_keys(snapshot->'financialSpace',array['domainSchemaVersion','currencyCatalogVersion','currencyDefinitions','accounts','operations','plans'],array['domainSchemaVersion','currencyCatalogVersion','currencyDefinitions','accounts','operations','plans']);
 if snapshot->>'schemaVersion' is distinct from '1' or coalesce(snapshot#>>'{financialSpace,domainSchemaVersion}','') not in ('4','5')
 or jsonb_typeof(snapshot#>'{financialSpace,accounts}') is distinct from 'array' or jsonb_typeof(snapshot#>'{financialSpace,operations}') is distinct from 'array'
 or jsonb_typeof(snapshot#>'{financialSpace,plans}') is distinct from 'array' or jsonb_array_length(snapshot#>'{financialSpace,plans}')>10000
 or jsonb_array_length(snapshot#>'{financialSpace,accounts}')>1000 or jsonb_array_length(snapshot#>'{financialSpace,operations}')>10000
 then return false; end if;
 defs:=snapshot#>'{financialSpace,currencyDefinitions}';
 if defs is distinct from (case snapshot#>>'{financialSpace,currencyCatalogVersion}'
  when 'currency-catalog-v1' then '[{"code":"DOP","minorUnitDigits":2},{"code":"USD","minorUnitDigits":2},{"code":"EUR","minorUnitDigits":2},{"code":"BOB","minorUnitDigits":2}]'::jsonb
  when 'pulso-currencies-v1' then '[{"code":"DOP","minorUnitDigits":2}]'::jsonb
  when 'pulso-p3-fixture-currencies-v1' then '[{"code":"DOP","minorUnitDigits":2},{"code":"USD","minorUnitDigits":2}]'::jsonb else null end) then return false; end if;
 for a in select value from jsonb_array_elements(snapshot#>'{financialSpace,accounts}') loop
  perform tr8_private.mcp_keys(a,array['id','name','bankName','currency','openingBalanceMinor','openingDate','type']||case when a->>'type'='credit' then array['creditLimitMinor','creditCard'] else array[]::text[] end,
   array['id','name','currency','openingBalanceMinor','openingDate','type']||case when a->>'type'='credit' then array['creditLimitMinor'] else array[]::text[] end);
  if coalesce(a->>'type','') not in ('cash','debit','credit') or jsonb_typeof(a->'openingBalanceMinor') is distinct from 'number' or (a->>'openingBalanceMinor')::numeric<>trunc((a->>'openingBalanceMinor')::numeric)
   or jsonb_typeof(a->'id') is distinct from 'string' or octet_length(a->>'id') not between 1 and 128 or a->>'id'<>btrim(a->>'id')
   or jsonb_typeof(a->'name') is distinct from 'string' or octet_length(a->>'name') not between 1 and 1024 or not length(btrim(a->>'name'))>0
   or jsonb_typeof(a->'openingDate') is distinct from 'string'
   or abs((a->>'openingBalanceMinor')::numeric)>9007199254740991 or a->>'openingDate' !~ '^\d{4}-\d{2}-\d{2}$'
   or not exists(select 1 from jsonb_array_elements(defs)c where c->>'code'=a->>'currency')
   or (a->>'type'='credit' and (jsonb_typeof(a->'creditLimitMinor') is distinct from 'number' or (a->>'creditLimitMinor')::numeric<>trunc((a->>'creditLimitMinor')::numeric) or (a->>'creditLimitMinor')::numeric<0 or (a->>'creditLimitMinor')::numeric>9007199254740991)) then return false; end if;
  perform (a->>'openingDate')::date;
 end loop;
 if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(snapshot#>'{financialSpace,accounts}')) then return false; end if;
 if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(snapshot#>'{financialSpace,operations}')) then return false; end if;
 for o in select value from jsonb_array_elements(snapshot#>'{financialSpace,operations}') loop
  perform tr8_private.mcp_keys(o,array['id','currency','amountMinor','date','kind','description','note']||
   case when o->>'kind' in ('income','expense') then array['accountId','category'] when o->>'kind'='refund' then array['originalExpenseId','destinationAccountId'] else array['fromAccountId','toAccountId']||case when o->>'kind'='card-payment' and o?'destinationCurrency' then array['destinationCurrency','destinationAmountMinor'] else array[]::text[] end end,
   array['id','currency','amountMinor','date','kind','description','note']||case when o->>'kind' in ('income','expense') then array['accountId','category'] when o->>'kind'='refund' then array['originalExpenseId','destinationAccountId'] else array['fromAccountId','toAccountId'] end);
  amount:=(o->>'amountMinor')::numeric;
  if coalesce(o->>'kind','') not in ('income','expense','transfer','card-payment','refund') or jsonb_typeof(o->'amountMinor') is distinct from 'number' or amount<=0 or amount<>trunc(amount) or amount>9007199254740991
   or jsonb_typeof(o->'id') is distinct from 'string' or octet_length(o->>'id') not between 1 and 128 or o->>'id'<>btrim(o->>'id')
   or jsonb_typeof(o->'description') is distinct from 'string' or octet_length(o->>'description') not between 1 and 1024 or not length(btrim(o->>'description'))>0
   or jsonb_typeof(o->'note') is distinct from 'string' or octet_length(o->>'note')>1024
   or jsonb_typeof(o->'date') is distinct from 'string' or o->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  perform (o->>'date')::date;
  if o->>'kind'='income' and coalesce(o->>'category','')<>all(array['salary','freelance','business','investment','gift','refund','other']) then return false; end if;
  if o->>'kind'='expense' and coalesce(o->>'category','')<>all(array['food','transport','home','health','leisure','shopping','services','other']) then return false; end if;
  if o?'destinationCurrency' and (snapshot#>>'{financialSpace,domainSchemaVersion}'<>'5' or o->>'destinationCurrency'=o->>'currency' or jsonb_typeof(o->'destinationAmountMinor') is distinct from 'number'
   or (o->>'destinationAmountMinor')::numeric<=0 or (o->>'destinationAmountMinor')::numeric>9007199254740991 or (o->>'destinationAmountMinor')::numeric<>trunc((o->>'destinationAmountMinor')::numeric)) then return false; end if;
  if o->>'kind' in ('income','expense') then
   if not exists(select 1 from jsonb_array_elements(snapshot#>'{financialSpace,accounts}')x where x->>'id'=o->>'accountId' and x->>'currency'=o->>'currency' and x->>'openingDate'<=o->>'date') then return false; end if;
  elsif o->>'kind'='refund' then
   if not exists(select 1 from jsonb_array_elements(snapshot#>'{financialSpace,accounts}')x where x->>'id'=o->>'destinationAccountId' and x->>'currency'=o->>'currency' and x->>'openingDate'<=o->>'date') then return false; end if;
  else
   if not exists(select 1 from jsonb_array_elements(snapshot#>'{financialSpace,accounts}')x where x->>'id'=o->>'fromAccountId' and x->>'currency'=o->>'currency' and x->>'type'<>'credit' and x->>'openingDate'<=o->>'date')
    or not exists(select 1 from jsonb_array_elements(snapshot#>'{financialSpace,accounts}')x where x->>'id'=o->>'toAccountId' and x->>'currency'=coalesce(o->>'destinationCurrency',o->>'currency') and (x->>'type'='credit')=(o->>'kind'='card-payment') and x->>'openingDate'<=o->>'date') then return false; end if;
  end if;
 end loop;
 -- Aggregate each affected day once. Prefix sums preserve date-closing checks
 -- without a dates × accounts × operations loop on the bounded snapshot.
 with accounts as (select x->>'id' id,x->>'currency' currency,x->>'type' account_type,(x->>'creditLimitMinor')::numeric credit_limit,x from jsonb_array_elements(snapshot#>'{financialSpace,accounts}')x),
 ops as (select x from jsonb_array_elements(snapshot#>'{financialSpace,operations}')x),
 raw as (select x->>'accountId' id,x->>'date' event_date,case when x->>'kind'='expense' then -(x->>'amountMinor')::numeric else (x->>'amountMinor')::numeric end delta from ops where x->>'kind' in ('income','expense')
  union all select x->>'destinationAccountId',x->>'date',(x->>'amountMinor')::numeric from ops where x->>'kind'='refund'
  union all select x->>'fromAccountId',x->>'date',-(x->>'amountMinor')::numeric from ops where x->>'kind' in ('transfer','card-payment')
  union all select x->>'toAccountId',x->>'date',coalesce(x->>'destinationAmountMinor',x->>'amountMinor')::numeric from ops where x->>'kind' in ('transfer','card-payment')),
 events as (select id,x->>'openingDate' event_date,(x->>'openingBalanceMinor')::numeric delta from accounts
  union all select r.id,r.event_date,case when a.account_type='credit' then -r.delta else r.delta end from raw r join accounts a on a.id=r.id),
 daily as (select id,event_date,sum(delta) delta from events group by id,event_date),
 states as (select d.id,d.event_date,a.currency,a.account_type,a.credit_limit,sum(d.delta)over(partition by d.id order by d.event_date)balance from daily d join accounts a on a.id=d.id),
 positions as (select *,case when account_type='credit' then balance else 0 end debt,case when account_type='credit' then 0 else balance end liquid,
  case when account_type='credit' then greatest(credit_limit-balance,0) else 0 end credit from states),
 changes as (select currency,event_date,liquid-lag(liquid,1,0::numeric)over(partition by id order by event_date)liquid,
  debt-lag(debt,1,0::numeric)over(partition by id order by event_date)debt,credit-lag(credit,1,0::numeric)over(partition by id order by event_date)credit from positions),
 totals as (select currency,event_date,sum(liquid)liquid,sum(debt)debt,sum(credit)credit from changes group by currency,event_date),
 closing as (select sum(liquid)over(partition by currency order by event_date)liquid,sum(debt)over(partition by currency order by event_date)debt,sum(credit)over(partition by currency order by event_date)credit from totals)
 select not exists(select 1 from positions where abs(balance)>9007199254740991 or credit>9007199254740991)
  and not exists(select 1 from closing where greatest(abs(liquid),abs(debt),abs(credit),abs(liquid-debt),abs(liquid+credit))>9007199254740991) into safe;
 return safe;
exception when others then return false;
end;$$;

-- Private credential-based core permits a separately authenticated OAuth bridge
-- without minting or copying a personal MCP key. Public callers cannot select it.
create function tr8_private.mcp_finance_dispatch_credential(p_credential_id uuid,p_action text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
<<finance_dispatch>>
declare c tr8_private.mcp_credentials; g tr8_private.mcp_finance_grants; ledger tr8_private.account_finances;
 actor uuid; workspace uuid; a jsonb; s jsonb; candidate jsonb; canonical jsonb; financial jsonb; source jsonb;
 notice tr8_private.mcp_finance_notices; prior tr8_private.mcp_finance_requests; alias tr8_private.mcp_finance_messages;
 result jsonb; item jsonb; payload_hash text; financial_hash text; bank_hash text; expected text; request_id uuid; notice_id uuid; operation_id uuid;
 account_id text; kind text; bank_status text; amount numeric; digits integer; currency text; occurred timestamptz; local_date date; zone text;
 description text; category text; reason text; start_at timestamptz; from_date date; to_date date; cursor_value text; page_size integer;
begin
 select workspace_id into workspace from tr8_private.mcp_credentials where id=p_credential_id;
 if not found then raise exception using errcode='PT401',message='Invalid MCP credential'; end if;
 perform tr8_private.v2_lock_workspace(workspace);
 select * into c from tr8_private.mcp_credentials where id=p_credential_id for update;
 if not found or c.revoked_at is not null or c.expires_at<=clock_timestamp() then raise exception using errcode='PT401',message='Invalid MCP credential'; end if;
 if (c.minute_start>clock_timestamp()-interval '1 minute' and c.minute_count>=60) or (c.day_start=current_date and c.day_count>=1000)
 then raise exception using errcode='PT429',message='MCP request limit reached'; end if;
 -- Reserve outside the savepoint: failed authorized calls consume quota while
 -- failed receipt/business writes roll back atomically. No payload enters logs.
 update tr8_private.mcp_credentials set last_used_at=clock_timestamp(),minute_count=case when minute_start<=clock_timestamp()-interval '1 minute' then 1 else minute_count+1 end,
 minute_start=case when minute_start<=clock_timestamp()-interval '1 minute' then clock_timestamp() else minute_start end,
 day_count=case when day_start<>current_date then 1 else day_count+1 end,day_start=current_date where id=c.id;
 begin
  if p_action is null or p_action not in ('finance_context','finance_list_accounts','finance_list_categories','finance_list_movements','finance_submit_notice','finance_list_reviews')
   or p_input is null or octet_length(p_input::text)>32768 then raise exception using errcode='22023',message='Invalid finance request'; end if;
  actor:=c.owner_id;
  -- Hold the current identity/enablement rows through commit; a simultaneous
  -- account disable, ban or deletion must serialize with delegated financial IO.
  perform 1 from auth.users u where u.id=actor for share;
  if not found then raise exception using errcode='PT403',message='Finance owner unavailable'; end if;
  perform 1 from tr8_private.app_users u where u.user_id=actor and u.enabled for share;
  if not found then raise exception using errcode='PT403',message='Finance owner unavailable'; end if;
  if not tr8_private.v2_user_live(actor) or not exists(select 1 from tr8_private.app_users where user_id=actor and enabled)
   or not exists(select 1 from tr8_private.workspaces w where w.id=workspace and w.kind='personal' and w.owner_id=actor)
   or not exists(select 1 from tr8_private.workspace_members where workspace_id=workspace and user_id=actor and status='active')
  then raise exception using errcode='PT403',message='Finance requires an active personal owner'; end if;
  select * into g from tr8_private.mcp_finance_grants where credential_id=c.id and owner_id=actor for share;
  if not found then
   if p_action='finance_context' then
    perform tr8_private.mcp_keys(p_input,array[]::text[]);
    return jsonb_build_object('enabled',false,'access',null,'version',null,'time_zone',null,'accounts','[]'::jsonb,'mailbox_ids','[]'::jsonb,'expense_categories','[]'::jsonb,'income_categories','[]'::jsonb);
   end if;
   raise exception using errcode='PT403',message='Finance has not been granted';
  end if;
  if p_action='finance_submit_notice' and g.access<>'write' then raise exception using errcode='PT403',message='Finance connection is read only'; end if;
  -- This is the same lock as the unchanged live-browser account_finance API.
  perform pg_advisory_xact_lock(hashtextextended('tr8-account-finance:'||actor::text,0));
  if c.expires_at<=clock_timestamp() then raise exception using errcode='PT401',message='MCP credential expired while waiting'; end if;
  select * into ledger from tr8_private.account_finances where owner_id=actor for update;
  s:=ledger.snapshot;
  if p_action='finance_context' then
   perform tr8_private.mcp_keys(p_input,array[]::text[]);
   return (tr8_private.mcp_finance_grant_json(g)-'credential_id')||jsonb_build_object('version',coalesce(ledger.version,0)::text,'time_zone',(select calendar_time_zone from tr8_private.app_users where user_id=actor));
  elsif p_action='finance_list_categories' then
   perform tr8_private.mcp_keys(p_input,array[]::text[]);
   return jsonb_build_object('expense_categories',to_jsonb(g.expense_categories),'income_categories',to_jsonb(g.income_categories));
  elsif p_action='finance_list_accounts' then
   perform tr8_private.mcp_keys(p_input,array['cursor','limit']); cursor_value:=p_input->>'cursor'; page_size:=coalesce((p_input->>'limit')::integer,50);
   if page_size not between 1 and 100 or (p_input?'cursor' and jsonb_typeof(p_input->'cursor')<>'string') or (cursor_value is not null and octet_length(cursor_value) not between 1 and 128)
    or (p_input?'limit' and (jsonb_typeof(p_input->'limit')<>'number' or p_input->>'limit' !~ '^[0-9]+$')) then raise exception using errcode='22023',message='Invalid page'; end if;
   with page as (select x,a.start_at from jsonb_array_elements(s#>'{financialSpace,accounts}')x join tr8_private.mcp_finance_accounts a on a.account_id=x->>'id' and a.credential_id=c.id
    where cursor_value is null or x->>'id'>cursor_value order by x->>'id' limit page_size+1), visible as (select * from page order by x->>'id' limit page_size)
   select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',x->>'id','name',tr8_private.mcp_finance_safe_text(x->>'name'),
    'type',x->>'type','currency',x->>'currency','minor_unit_digits',(select (d->>'minorUnitDigits')::integer from jsonb_array_elements(s#>'{financialSpace,currencyDefinitions}')d where d->>'code'=x->>'currency'),'start_at',tr8_private.mcp_finance_utc(v.start_at)) order by x->>'id') from visible v),'[]'::jsonb),
    'next_cursor',case when (select count(*) from page)>page_size then (select x->>'id' from visible order by x->>'id' desc limit 1) else null end,'version',coalesce(ledger.version,0)::text) into result;
   return result;
  elsif p_action='finance_list_movements' then
   perform tr8_private.mcp_keys(p_input,array['cursor','limit','date_from','date_to','account_id','kind'],array['date_from','date_to']);
   from_date:=(p_input->>'date_from')::date; to_date:=(p_input->>'date_to')::date;
   cursor_value:=p_input->>'cursor'; page_size:=coalesce((p_input->>'limit')::integer,50);
   if jsonb_typeof(p_input->'date_from')<>'string' or jsonb_typeof(p_input->'date_to')<>'string' or p_input->>'date_from' !~ '^\d{4}-\d{2}-\d{2}$' or p_input->>'date_to' !~ '^\d{4}-\d{2}-\d{2}$' or from_date>=to_date or to_date-from_date>93
    or page_size not between 1 and 100 or (cursor_value is not null and octet_length(cursor_value) not between 1 and 128)
    or (p_input?'cursor' and jsonb_typeof(p_input->'cursor')<>'string') or (p_input?'account_id' and jsonb_typeof(p_input->'account_id')<>'string')
    or (p_input?'kind' and jsonb_typeof(p_input->'kind')<>'string')
    or (p_input?'kind' and p_input->>'kind' not in ('income','expense','transfer','card-payment','refund'))
    or (p_input?'limit' and (jsonb_typeof(p_input->'limit')<>'number' or p_input->>'limit' !~ '^[0-9]+$')) then raise exception using errcode='22023',message='Invalid movement filters'; end if;
   if p_input?'account_id' and not exists(select 1 from tr8_private.mcp_finance_accounts where credential_id=c.id and mcp_finance_accounts.account_id=p_input->>'account_id')
   then raise exception using errcode='PT403',message='Account not granted'; end if;
   with page as (select x from jsonb_array_elements(s#>'{financialSpace,operations}')x where x->>'date'>=from_date::text and x->>'date'<to_date::text
    and (cursor_value is null or x->>'id'>cursor_value) and (not p_input?'kind' or x->>'kind'=p_input->>'kind')
    and exists(select 1 from tr8_private.mcp_finance_accounts a where a.credential_id=c.id
     and (not p_input?'account_id' or a.account_id=p_input->>'account_id')
     and a.account_id=any(array[x->>'accountId',x->>'fromAccountId',x->>'toAccountId',x->>'destinationAccountId']))
    order by x->>'id' limit page_size+1), visible as (select * from page order by x->>'id' limit page_size),
    scoped as (select x,(x->>'kind'='card-payment' and x?'destinationCurrency' and (p_input->>'account_id'=x->>'toAccountId'
     or not exists(select 1 from tr8_private.mcp_finance_accounts a where a.credential_id=c.id and a.account_id=x->>'fromAccountId'))) is true destination_leg from visible)
   select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',x->>'id','kind',x->>'kind','date',x->>'date','currency',case when destination_leg then x->>'destinationCurrency' else x->>'currency' end,
    'amount',tr8_private.mcp_finance_decimal((case when destination_leg then x->>'destinationAmountMinor' else x->>'amountMinor' end)::numeric,
     (select (d->>'minorUnitDigits')::integer from jsonb_array_elements(s#>'{financialSpace,currencyDefinitions}')d where d->>'code'=case when destination_leg then x->>'destinationCurrency' else x->>'currency' end)),
    'description',tr8_private.mcp_finance_safe_text(x->>'description'),'category',x->>'category',
    'account_id',case when exists(select 1 from tr8_private.mcp_finance_accounts a where a.credential_id=c.id and a.account_id=x->>'accountId') then x->>'accountId' end,
    'from_account_id',case when exists(select 1 from tr8_private.mcp_finance_accounts a where a.credential_id=c.id and a.account_id=x->>'fromAccountId') then x->>'fromAccountId' end,
    'to_account_id',case when exists(select 1 from tr8_private.mcp_finance_accounts a where a.credential_id=c.id and a.account_id=x->>'toAccountId') then x->>'toAccountId' end,
    'destination_account_id',case when exists(select 1 from tr8_private.mcp_finance_accounts a where a.credential_id=c.id and a.account_id=x->>'destinationAccountId') then x->>'destinationAccountId' end)) order by x->>'id') from scoped),'[]'::jsonb),
    'next_cursor',case when (select count(*) from page)>page_size then (select x->>'id' from visible order by x->>'id' desc limit 1) else null end,'version',coalesce(ledger.version,0)::text) into result;
   return result;
  elsif p_action='finance_list_reviews' then
   perform tr8_private.mcp_keys(p_input,array['cursor','limit']); cursor_value:=p_input->>'cursor'; page_size:=coalesce((p_input->>'limit')::integer,50);
   if page_size not between 1 and 100 or (p_input?'limit' and (jsonb_typeof(p_input->'limit')<>'number' or p_input->>'limit' !~ '^[0-9]+$')) then raise exception using errcode='22023',message='Invalid review page'; end if;
   with page as (select n.* from tr8_private.mcp_finance_notices n join tr8_private.mcp_finance_accounts a on a.credential_id=c.id and a.account_id=n.account_id
    where n.owner_id=actor and n.status='review' and (cursor_value is null or n.id>cursor_value::uuid)
    and exists(select 1 from tr8_private.mcp_finance_messages m where m.owner_id=actor and m.notice_id=n.id and m.mailbox_id=any(g.mailbox_ids)) order by n.id limit page_size+1),
    visible as (select * from page order by id limit page_size)
   select jsonb_build_object('items',coalesce((select jsonb_agg(tr8_private.mcp_finance_review_json(v::tr8_private.mcp_finance_notices) order by v.id) from visible v),'[]'::jsonb),
    'next_cursor',case when (select count(*) from page)>page_size then (select id::text from visible order by id desc limit 1) else null end,'version',coalesce(ledger.version,0)::text) into result;
   return result;
  end if;
  perform tr8_private.mcp_keys(p_input,array['request_id','expected_version','source','account_id','kind','status','amount','currency','occurred_at','time_zone','date','description','category'],array['request_id','expected_version','source','account_id']);
  request_id:=(p_input->>'request_id')::uuid; expected:=p_input->>'expected_version';
  if jsonb_typeof(p_input->'request_id')<>'string' or request_id is null or jsonb_typeof(p_input->'expected_version')<>'string' or expected !~ '^(0|[1-9][0-9]{0,15})$' or expected::numeric>=9007199254740991
   or jsonb_typeof(p_input->'account_id')<>'string' or octet_length(p_input->>'account_id') not between 1 and 128 or p_input->>'account_id'<>btrim(p_input->>'account_id')
  then raise exception using errcode='22023',message='Invalid notice identifiers'; end if;
  account_id:=p_input->>'account_id';
  select x,z.start_at into a,start_at from jsonb_array_elements(s#>'{financialSpace,accounts}')x join tr8_private.mcp_finance_accounts z on z.credential_id=c.id and z.account_id=x->>'id' where x->>'id'=finance_dispatch.account_id;
  if not found then raise exception using errcode='PT403',message='Account not granted'; end if;
  source:=p_input->'source';
  perform tr8_private.mcp_keys(source,array['provider','mailbox_id','message_id','bank_transaction_id'],array['provider','mailbox_id','message_id']);
  if source->>'provider'<>'gmail' or jsonb_typeof(source->'provider')<>'string' or jsonb_typeof(source->'mailbox_id')<>'string' or source->>'mailbox_id' !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(source->'message_id')<>'string' or source->>'message_id' !~ '^[A-Za-z0-9_-]{1,128}$'
   or (source?'bank_transaction_id' and (jsonb_typeof(source->'bank_transaction_id')<>'string' or source->>'bank_transaction_id' !~ '^[a-f0-9]{64}$'))
  then raise exception using errcode='22023',message='Invalid opaque source identifiers'; end if;
  if not source->>'mailbox_id'=any(g.mailbox_ids) then raise exception using errcode='PT403',message='Mailbox not granted'; end if;
  kind:=coalesce(p_input->>'kind','unknown'); bank_status:=coalesce(p_input->>'status','unknown');
  if kind not in ('purchase','income','own_transfer','card_payment','refund','reversal','unknown') or bank_status not in ('posted','pending','rejected','cancelled','unknown')
   or (p_input?'kind' and jsonb_typeof(p_input->'kind')<>'string') or (p_input?'status' and jsonb_typeof(p_input->'status')<>'string')
  then raise exception using errcode='22023',message='Invalid bank classification'; end if;
  currency:=p_input->>'currency';
  select (x->>'minorUnitDigits')::integer into digits from jsonb_array_elements(s#>'{financialSpace,currencyDefinitions}')x where x->>'code'=a->>'currency';
  if digits is null or digits not between 0 and 6 then raise exception using errcode='22023',message='Unsupported currency definition'; end if;
  if p_input?'currency' and (jsonb_typeof(p_input->'currency')<>'string' or currency !~ '^[A-Z]{3}$' or currency<>a->>'currency') then raise exception using errcode='22023',message='Notice currency differs from account'; end if;
  if p_input?'amount' then
   if jsonb_typeof(p_input->'amount')<>'string' then raise exception using errcode='22023',message='Amount must be exact decimal text'; end if;
   amount:=tr8_private.mcp_finance_minor(p_input->>'amount',digits);
  end if;
  if p_input?'occurred_at' then
   if jsonb_typeof(p_input->'occurred_at')<>'string' then raise exception using errcode='22023',message='Invalid occurrence instant'; end if;
   occurred:=tr8_private.mcp_finance_instant(p_input->>'occurred_at');
  end if;
  zone:=p_input->>'time_zone';
  if p_input?'time_zone' and (jsonb_typeof(p_input->'time_zone')<>'string' or length(zone)>100 or not exists(select 1 from pg_timezone_names where name=zone) or (zone<>'UTC' and strpos(zone,'/')=0)) then raise exception using errcode='22023',message='Invalid IANA timezone'; end if;
  if p_input?'date' then
   if jsonb_typeof(p_input->'date')<>'string' or p_input->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception using errcode='22023',message='Invalid local date'; end if;
   local_date:=(p_input->>'date')::date;
  end if;
  if occurred is not null and zone is not null then
   if local_date is not null and local_date<>(occurred at time zone zone)::date then raise exception using errcode='22023',message='Occurrence and local date disagree'; end if;
   local_date:=(occurred at time zone zone)::date;
  end if;
  if local_date is not null and extract(year from local_date) not between 1 and 9999 then raise exception using errcode='22023',message='Local date outside supported range'; end if;
  description:=btrim(p_input->>'description');
  if p_input?'description' and (jsonb_typeof(p_input->'description')<>'string' or length(description) not between 1 and 240 or octet_length(description)>1024 or description ~ '[[:cntrl:]]'
   or description ~ U&'[\202A-\202E\2066-\2069\200E\200F]' or description ~ '([0-9][ -]?){8,}'
   or not tr8_private.mcp_finance_text_ok(description)) then raise exception using errcode='22023',message='Description must be minimal and redacted'; end if;
  category:=coalesce(p_input->>'category','other');
  if p_input?'category' and (jsonb_typeof(p_input->'category')<>'string' or category<>all(array['food','transport','home','health','leisure','shopping','services','salary','freelance','business','investment','gift','refund','other'])) then raise exception using errcode='22023',message='Invalid category'; end if;
  if (kind='income' and category<>all(array['salary','freelance','business','investment','gift','refund','other']))
   or (kind='purchase' and category<>all(array['food','transport','home','health','leisure','shopping','services','other']))
  then raise exception using errcode='22023',message='Category does not match movement kind'; end if;
  if (kind='income' and not category=any(g.income_categories)) or (kind='purchase' and not category=any(g.expense_categories))
   or (kind not in ('income','purchase') and p_input?'category' and not category=any(g.income_categories||g.expense_categories)) then raise exception using errcode='PT403',message='Category not granted'; end if;
  if source?'bank_transaction_id' then bank_hash:=encode(sha256(convert_to(source->>'bank_transaction_id','UTF8')),'hex'); end if;
  financial:=jsonb_build_object('account_id',account_id,'kind',kind,'status',bank_status,'amount',case when amount is not null then tr8_private.mcp_finance_decimal(amount,digits) end,
   'currency',currency,'occurred_at',case when occurred is not null then tr8_private.mcp_finance_utc(occurred) end,'time_zone',zone,'date',local_date::text,'description',description,'category',category);
  canonical:=financial||jsonb_build_object('source',jsonb_build_object('provider','gmail','mailbox_id',source->>'mailbox_id','message_id',source->>'message_id','bank_reference_hash',bank_hash));
  payload_hash:=tr8_private.mcp_finance_hash(canonical); financial_hash:=tr8_private.mcp_finance_hash(financial);
  select * into prior from tr8_private.mcp_finance_requests r where r.owner_id=actor and r.request_id=finance_dispatch.request_id;
  if found then
   if prior.payload_hash<>payload_hash then raise exception using errcode='PT409',message='Idempotency payload conflict'; end if;
   return prior.result;
  end if;
  -- Existing request IDs remain replayable at capacity. Every new request or
  -- alias stops before any receipt or ledger write, and no history is pruned.
  perform tr8_private.mcp_finance_require_capacity(actor);
  select * into alias from tr8_private.mcp_finance_messages m where m.owner_id=actor and m.mailbox_id=source->>'mailbox_id' and m.message_id=source->>'message_id';
  if found then
   if alias.payload_hash<>payload_hash then raise exception using errcode='PT409',message='Source payload conflict'; end if;
   select * into notice from tr8_private.mcp_finance_notices where owner_id=actor and id=alias.notice_id;
   insert into tr8_private.mcp_finance_requests values(actor,request_id,notice.id,payload_hash,notice.result);
   return notice.result;
  end if;
  if bank_hash is not null then
   select * into notice from tr8_private.mcp_finance_notices n where n.owner_id=actor and n.account_id=finance_dispatch.account_id and n.bank_reference_hash=bank_hash;
   if found and notice.financial_hash=financial_hash then
    insert into tr8_private.mcp_finance_messages values(actor,source->>'mailbox_id',source->>'message_id',notice.id,payload_hash);
    insert into tr8_private.mcp_finance_requests values(actor,request_id,notice.id,payload_hash,notice.result);
    return notice.result;
   elsif found then reason:='bank_reference_conflict'; bank_hash:=null; end if;
  end if;
  if expected<>coalesce(ledger.version,0)::text then raise exception using errcode='PT409',message='Finance version conflict'; end if;
  if reason is null then
   reason:=case when kind not in ('income','purchase') then 'unsupported_kind' when bank_status<>'posted' then 'unconfirmed_status'
    when amount is null then 'missing_amount' when currency is null then 'missing_currency' when occurred is null then 'missing_occurred_at'
    when zone is null then 'missing_time_zone' when description is null then 'missing_description' when bank_hash is null then 'missing_bank_transaction_id'
    when occurred<start_at then 'before_import_start' when local_date::text<=a->>'openingDate' or local_date::text<=a#>>'{creditCard,baseline,asOfDate}' then 'captured_balance'
    when occurred>clock_timestamp() then 'future_notice' when kind='income' and a->>'type'='credit' then 'credit_income_requires_review'
    when kind='income' and category='refund' then 'refund_requires_review' else null end;
  end if;
  if reason is null and exists(select 1 from jsonb_array_elements(s#>'{financialSpace,operations}')x where x->>'date'=local_date::text
   and case when x->>'toAccountId'=account_id and x->>'kind'='card-payment' then coalesce(x->>'destinationCurrency',x->>'currency') else x->>'currency' end=currency
   and (case when x->>'toAccountId'=account_id and x->>'kind'='card-payment' then coalesce(x->>'destinationAmountMinor',x->>'amountMinor') else x->>'amountMinor' end)::numeric=amount
   and account_id=any(array[x->>'accountId',x->>'fromAccountId',x->>'toAccountId',x->>'destinationAccountId'])) then reason:='possible_duplicate'; end if;
  notice_id:=gen_random_uuid(); operation_id:=null;
  if reason is null then
   if jsonb_array_length(s#>'{financialSpace,operations}')>=10000 then reason:='operation_limit';
   else
    operation_id:=gen_random_uuid(); item:=jsonb_build_object('id',operation_id::text,'kind',case when kind='purchase' then 'expense' else 'income' end,'currency',currency,'amountMinor',amount,'date',local_date::text,'accountId',account_id,'description',description,'note','','category',category);
    candidate:=jsonb_set(s,'{financialSpace,operations}',(s#>'{financialSpace,operations}')||jsonb_build_array(item));
    if octet_length(candidate::text)>1048576 or not tr8_private.mcp_finance_balance_safe(candidate) then reason:='balance_range'; operation_id:=null;
    else
     if c.expires_at<=clock_timestamp() then raise exception using errcode='PT401',message='MCP credential expired while validating'; end if;
     update tr8_private.account_finances set version=version+1,snapshot=candidate,operation_id=request_id,updated_at=clock_timestamp() where owner_id=actor returning * into ledger;
    end if;
   end if;
  end if;
  result:=jsonb_build_object('notice_id',notice_id,'status',case when reason is null then 'recorded' else 'review' end,'operation_id',operation_id,'review_reason',reason,'version',coalesce(ledger.version,0)::text);
  if c.expires_at<=clock_timestamp() then raise exception using errcode='PT401',message='MCP credential expired while preparing receipt'; end if;
  insert into tr8_private.mcp_finance_notices(id,owner_id,account_id,kind,bank_status,bank_reference_hash,financial_hash,canonical,status,review_reason,operation_id,result)
   values(notice_id,actor,account_id,kind,bank_status,bank_hash,financial_hash,canonical,case when reason is null then 'recorded' else 'review' end,reason,operation_id,result);
  insert into tr8_private.mcp_finance_messages values(actor,source->>'mailbox_id',source->>'message_id',notice_id,payload_hash);
  insert into tr8_private.mcp_finance_requests values(actor,request_id,notice_id,payload_hash,result);
  return result;
 exception when others then
  return jsonb_build_object('_tr8_mcp_error',jsonb_build_object('code',sqlstate));
 end;
end;$$;

create function tr8_private.mcp_finance_dispatch(p_token text,p_action text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare credential uuid;
begin
 if p_token is null or p_token !~ '^tr8_mcp_[a-f0-9]{64}$' then raise exception using errcode='PT401',message='Invalid MCP credential'; end if;
 select id into credential from tr8_private.mcp_credentials where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if not found then raise exception using errcode='PT401',message='Invalid MCP credential'; end if;
 return tr8_private.mcp_finance_dispatch_credential(credential,p_action,p_input);
end;$$;

revoke all on function tr8_private.mcp_finance_hash(jsonb),tr8_private.mcp_finance_text_ok(text),tr8_private.mcp_finance_safe_text(text),tr8_private.mcp_finance_require_capacity(uuid),tr8_private.mcp_finance_instant(text),tr8_private.mcp_finance_utc(timestamptz),
 tr8_private.mcp_finance_minor(text,integer),tr8_private.mcp_finance_decimal(numeric,integer),tr8_private.mcp_finance_grant_json(tr8_private.mcp_finance_grants),
 tr8_private.mcp_finance_review_json(tr8_private.mcp_finance_notices),tr8_private.mcp_finance_balance_safe(jsonb),
 tr8_private.mcp_finance_manage(text,jsonb),tr8_private.mcp_finance_dispatch_credential(uuid,text,jsonb),tr8_private.mcp_finance_dispatch(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function tr8_private.mcp_finance_manage(text,jsonb) to authenticated;
grant execute on function tr8_private.mcp_finance_dispatch(text,text,jsonb) to anon,authenticated;
create function public.tr8_mcp_finance_manage(p_action text,p_input jsonb default '{}'::jsonb) returns jsonb
language sql volatile security invoker set search_path='' as $$select tr8_private.mcp_finance_manage(p_action,p_input);$$;
create function public.tr8_mcp_finance_dispatch(p_token text,p_action text,p_input jsonb default '{}'::jsonb) returns jsonb
language sql volatile security invoker set search_path='' as $$select tr8_private.mcp_finance_dispatch(p_token,p_action,p_input);$$;
revoke all on function public.tr8_mcp_finance_manage(text,jsonb),public.tr8_mcp_finance_dispatch(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.tr8_mcp_finance_manage(text,jsonb) to authenticated;
grant execute on function public.tr8_mcp_finance_dispatch(text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
