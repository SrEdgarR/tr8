-- Offline / disposable synthetic database only. Applies no migration, touches no
-- real identities, and rolls back every fixture/receipt/grant/account change.
begin;
select set_config('tr8.finance_test_checks','0',true);
create temporary table fin_values(key text primary key,value jsonb) on commit drop;
create function pg_temp.fin_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Finance MCP assertion failed: %',label; end if;
 perform set_config('tr8.finance_test_checks',(current_setting('tr8.finance_test_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.fin_actor(n integer,live boolean default true) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub','f9000000-0000-4000-8000-'||lpad(n::text,12,'0'),'role','authenticated',
 'session_id',case when live then 'f9000000-0000-4000-8000-'||lpad(n::text,12,'0') end)::text,true)::text::void;
$$;
create function pg_temp.fin_put(k text,v jsonb) returns void language sql as $$insert into pg_temp.fin_values values(k,v) on conflict(key)do update set value=excluded.value;$$;
create function pg_temp.fin_get(k text) returns jsonb language sql as $$select value from pg_temp.fin_values where key=k;$$;
create function pg_temp.fin_call(keychar text,action text,i jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select public.tr8_mcp_finance_dispatch('tr8_mcp_'||repeat(keychar,64),action,i);
$$;
create function pg_temp.fin_input(n integer,patch jsonb default '{}'::jsonb) returns jsonb language sql as $$select jsonb_build_object(
 'request_id','f9000020-0000-4000-8000-'||lpad(n::text,12,'0'),'expected_version','1','source',jsonb_build_object('provider','gmail','mailbox_id',repeat('a',64),
 'message_id','synthetic_message_'||n,'bank_transaction_id',encode(sha256(convert_to('synthetic bank transaction '||n,'UTF8')),'hex')),
 'account_id','cash-dop','kind','purchase','status','posted','amount',(100+n)::text||'.20','currency','DOP','occurred_at','2026-06-01T16:00:00Z',
 'time_zone','America/La_Paz','description','Comercio ficticio','category','food')||patch;$$;
create function pg_temp.fin_error(command text,code text,label text) returns void language plpgsql as $$declare r jsonb;begin
 begin execute command into r; if r#>>'{_tr8_mcp_error,code}'=code then perform pg_temp.fin_assert(true,label);return;end if;
 exception when others then if sqlstate=code then perform pg_temp.fin_assert(true,label);return;end if;raise exception 'Finance MCP assertion failed: %; expected %, actual %',label,code,sqlstate;end;
 raise exception 'Finance MCP assertion failed: %; expected error %, actual %',label,code,r;
end;$$;
do $$begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace::text);end;$$;
grant all on pg_temp.fin_values to anon,authenticated;
grant execute on function pg_temp.fin_assert(boolean,text),pg_temp.fin_actor(integer,boolean),pg_temp.fin_put(text,jsonb),pg_temp.fin_get(text),pg_temp.fin_call(text,text,jsonb),pg_temp.fin_input(integer,jsonb),pg_temp.fin_error(text,text,text) to anon,authenticated;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f9000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','finance-mcp-'||n||'@example.test',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp() from generate_series(1,2)n;
insert into auth.sessions(id,user_id,created_at,updated_at)select id,id,clock_timestamp(),clock_timestamp() from auth.users where id::text like 'f9000000%';
insert into tr8_private.app_users(user_id,enabled)select id,true from auth.users where id::text like 'f9000000%';
insert into tr8_private.workspaces(id,owner_id,kind,name)values
 ('f9000010-0000-4000-8000-000000000001','f9000000-0000-4000-8000-000000000001','personal','Personal synthetic'),
 ('f9000010-0000-4000-8000-000000000002','f9000000-0000-4000-8000-000000000002','personal','Other synthetic'),
 ('f9000010-0000-4000-8000-000000000003','f9000000-0000-4000-8000-000000000001','team','Team synthetic');
insert into tr8_private.workspace_members(workspace_id,user_id)select id,owner_id from tr8_private.workspaces where id::text like 'f9000010%';
insert into tr8_private.mcp_credentials(id,owner_id,workspace_id,name,access,token_hash,expires_at)
select ('f9000030-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n=4 then 'f9000000-0000-4000-8000-000000000002'::uuid else 'f9000000-0000-4000-8000-000000000001'::uuid end,
 case when n=4 then 'f9000010-0000-4000-8000-000000000002'::uuid when n=5 then 'f9000010-0000-4000-8000-000000000003'::uuid else 'f9000010-0000-4000-8000-000000000001'::uuid end,
 'Synthetic MCP '||n,'read',encode(sha256(convert_to('tr8_mcp_'||repeat(chr(96+n),64),'UTF8')),'hex'),clock_timestamp()+interval '1 day' from generate_series(1,5)n;
insert into tr8_private.account_finances(owner_id,version,operation_id,snapshot)values('f9000000-0000-4000-8000-000000000001',1,gen_random_uuid(),
 '{"schemaVersion":1,"financialSpace":{"domainSchemaVersion":5,"currencyCatalogVersion":"currency-catalog-v1","currencyDefinitions":[{"code":"DOP","minorUnitDigits":2},{"code":"USD","minorUnitDigits":2},{"code":"EUR","minorUnitDigits":2},{"code":"BOB","minorUnitDigits":2}],"accounts":[{"id":"cash-dop","type":"debit","name":"Ahorro sintético","currency":"DOP","openingBalanceMinor":1000000,"openingDate":"2026-01-01"},{"id":"card-usd","type":"credit","name":"Tarjeta sintética","currency":"USD","openingBalanceMinor":0,"openingDate":"2026-01-01","creditLimitMinor":100000},{"id":"private-usd","type":"debit","name":"No autorizada","currency":"USD","openingBalanceMinor":1000,"openingDate":"2026-01-01"}],"operations":[{"id":"manual-old","kind":"expense","currency":"DOP","amountMinor":500,"date":"2026-06-01","accountId":"cash-dop","description":"Registro manual previo","note":"No compartir","category":"other"}],"plans":[]}}');
insert into tr8_private.account_finances(owner_id,version,operation_id,snapshot)values('f9000000-0000-4000-8000-000000000002',1,gen_random_uuid(),
 '{"schemaVersion":1,"financialSpace":{"domainSchemaVersion":4,"currencyCatalogVersion":"currency-catalog-v1","currencyDefinitions":[{"code":"DOP","minorUnitDigits":2},{"code":"USD","minorUnitDigits":2},{"code":"EUR","minorUnitDigits":2},{"code":"BOB","minorUnitDigits":2}],"accounts":[{"id":"foreign","type":"cash","name":"Ajena","currency":"DOP","openingBalanceMinor":0,"openingDate":"2026-01-01"}],"operations":[],"plans":[]}}');
select pg_temp.fin_put('other_snapshot',(select to_jsonb(f) from tr8_private.account_finances f where owner_id='f9000000-0000-4000-8000-000000000002'));

set local role authenticated;
select pg_temp.fin_actor(1);
select pg_temp.fin_put('grant',public.tr8_mcp_finance_manage('set_grant',jsonb_build_object('credential_id','f9000030-0000-4000-8000-000000000001','access','write',
 'accounts','[{"account_id":"cash-dop","start_at":"2026-01-02T00:00:00Z"},{"account_id":"card-usd","start_at":"2026-01-02T00:00:00Z"}]'::jsonb,
 'mailbox_ids',jsonb_build_array(repeat('a',64)),'expense_categories','["food","other"]'::jsonb,'income_categories','["salary","other","refund"]'::jsonb)));
select pg_temp.fin_assert(pg_temp.fin_get('grant')->>'enabled'='true','explicit browser grant');
select pg_temp.fin_put('readgrant',public.tr8_mcp_finance_manage('set_grant',(pg_temp.fin_get('grant')-'enabled')||'{"credential_id":"f9000030-0000-4000-8000-000000000003","access":"read","mailbox_ids":[],"expense_categories":[],"income_categories":[]}'));
select pg_temp.fin_assert(pg_temp.fin_get('readgrant')->'mailbox_ids'='[]'::jsonb,'read-only grant needs no mailbox identity');
select pg_temp.fin_error($q$select public.tr8_mcp_finance_manage('set_grant',(pg_temp.fin_get('readgrant')-'enabled')||'{"access":"write"}')$q$,'22023','write grant still requires at least one mailbox');
select pg_temp.fin_assert(jsonb_array_length(public.tr8_mcp_finance_manage('list')->'items')=2,'owner grant listing');
select pg_temp.fin_error($q$select public.tr8_mcp_finance_manage('set_grant',(pg_temp.fin_get('grant')-'enabled')||'{"credential_id":"f9000030-0000-4000-8000-000000000005"}')$q$,'PT403','team scope cannot access finance');
select pg_temp.fin_actor(2);
select pg_temp.fin_assert(jsonb_array_length(public.tr8_mcp_finance_manage('list')->'items')=0,'grants isolated by owner');
select pg_temp.fin_error($q$select public.tr8_mcp_finance_manage('revoke_grant','{"credential_id":"f9000030-0000-4000-8000-000000000001"}')$q$,'PT404','cannot revoke another owner grant');
select pg_temp.fin_actor(1,false);
select pg_temp.fin_error($q$select public.tr8_mcp_finance_manage('list')$q$,'42501','management requires actual browser session');
set local role anon;
select pg_temp.fin_error($q$select public.tr8_mcp_finance_manage('list')$q$,'42501','anonymous management denied');
select pg_temp.fin_error($q$select * from tr8_private.mcp_finance_requests$q$,'42501','receipt tables private');
select pg_temp.fin_error($q$select * from tr8_private.mcp_finance_grants$q$,'42501','grant table private');
select pg_temp.fin_assert(pg_temp.fin_call('b','finance_context')->>'enabled'='false','legacy credentials do not inherit finance');
select pg_temp.fin_error($q$select pg_temp.fin_call('b','finance_list_accounts')$q$,'PT403','legacy read forbidden');
select pg_temp.fin_error($q$select pg_temp.fin_call('c','finance_submit_notice',pg_temp.fin_input(1))$q$,'PT403','finance read scope cannot write');
select pg_temp.fin_assert(jsonb_array_length(pg_temp.fin_call('c','finance_list_accounts')->'items')=2,'read grant without mailbox can consult authorized accounts');
select pg_temp.fin_assert(jsonb_array_length(pg_temp.fin_call('c','finance_list_movements','{"date_from":"2026-06-01","date_to":"2026-06-02"}')->'items')=1,'read grant without mailbox can consult existing movements');
select pg_temp.fin_assert(pg_temp.fin_call('c','finance_context')->'mailbox_ids'='[]'::jsonb,'read-only context does not fabricate a mailbox');
select pg_temp.fin_put('context',pg_temp.fin_call('a','finance_context'));
select pg_temp.fin_assert(pg_temp.fin_get('context')->>'version'='1','financial version exposed only with explicit grant');
select pg_temp.fin_assert(jsonb_array_length(pg_temp.fin_call('a','finance_list_accounts')->'items')=2,'only two authorized accounts listed');
select pg_temp.fin_assert(jsonb_array_length(pg_temp.fin_call('a','finance_list_categories')->'expense_categories')=2,'authorized category subset');
select pg_temp.fin_put('expense',pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20"}')));
select pg_temp.fin_assert(pg_temp.fin_get('expense')->>'status'='recorded','valid expense recorded');
select pg_temp.fin_assert(pg_temp.fin_get('expense')->>'version'='2','expense increments existing ledger version');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20"}'))=pg_temp.fin_get('expense'),'retry/lost response returns exact receipt');
select pg_temp.fin_put('income',pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(2,'{"expected_version":"2","kind":"income","amount":"55.12","category":"salary"}')));
select pg_temp.fin_assert(pg_temp.fin_get('income')->>'status'='recorded','valid income recorded');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20"}'))=pg_temp.fin_get('expense'),'receipt persists after later writes');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20","occurred_at":"2026-06-01T12:00:00-04:00"}'))=pg_temp.fin_get('expense'),'equivalent instant offsets share canonical receipt');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.21"}'))$q$,'PT409','same request changed payload conflict');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(10,'{"source":{"provider":"gmail","mailbox_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","message_id":"synthetic_message_1"}}'))$q$,'PT409','same source changed payload conflict');
select pg_temp.fin_put('second_email',pg_temp.fin_input(1,'{"request_id":"f9000020-0000-4000-8000-000000000099","amount":"20.20"}')||jsonb_build_object('source',(pg_temp.fin_input(1)->'source')||'{"message_id":"second_notice_same_transaction"}'));
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_get('second_email'))=pg_temp.fin_get('expense'),'different email same bank operation links once');
select pg_temp.fin_put('review_duplicate',pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(3,'{"expected_version":"3","amount":"20.20"}')));
select pg_temp.fin_assert(pg_temp.fin_get('review_duplicate')->>'review_reason'='possible_duplicate','equal amount/date distinct bank reference stays review');
select pg_temp.fin_assert(pg_temp.fin_get('review_duplicate')->>'version'='3','possible duplicate does not change balance');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(4,'{"expected_version":"3","amount":"5.00"}'))->>'review_reason'='possible_duplicate','manual prior entry reconciliation');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(5,'{"expected_version":"1"}'))$q$,'PT409','stale browser/worker expected version conflicts');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(6,'{"account_id":"foreign","expected_version":"3"}'))$q$,'PT403','foreign account denied before receipt');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(7,'{"account_id":"private-usd","currency":"USD","expected_version":"3"}'))$q$,'PT403','same owner ungranted account denied');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(8,'{"currency":"USD","expected_version":"3"}'))$q$,'22023','wrong currency never converted');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(9,'{"amount":"0.001","expected_version":"3"}'))$q$,'22023','fractional cent rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(11,'{"category":"home","expected_version":"3"}'))$q$,'PT403','ungranted category denied');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(12,'{"category":"salary","expected_version":"3"}'))$q$,'22023','category incompatible with expense rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(13,'{"description":"Tarjeta 1234567890123456","expected_version":"3"}'))$q$,'22023','full card number rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(14,'{"description":"Codigo\n123456","expected_version":"3"}'))$q$,'22023','control characters rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(15,'{"date":"2026-06-02","expected_version":"3"}'))$q$,'22023','zone local date mismatch rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(16,'{"time_zone":"PST","expected_version":"3"}'))$q$,'22023','ambiguous timezone rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(17,'{"raw_email":"email body","expected_version":"3"}'))$q$,'22023','email body/extra fields rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(18,'{"expected_version":"3","source":{"provider":"gmail","mailbox_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","message_id":"unauthorized_mailbox"}}'))$q$,'PT403','mailbox allowlist enforced');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(19,'{"expected_version":"3","kind":"own_transfer","category":"other"}'))->>'review_reason'='unsupported_kind','own transfer never new income');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(20,'{"expected_version":"3","kind":"card_payment","category":"other"}'))->>'review_reason'='unsupported_kind','card payment never duplicate expense');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(21,'{"expected_version":"3","kind":"refund","category":"other"}'))->>'review_reason'='unsupported_kind','refund held for original expense link');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(22,'{"expected_version":"3","kind":"reversal","category":"other"}'))->>'review_reason'='unsupported_kind','reversal held for review');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(23,'{"expected_version":"3","status":"pending"}'))->>'review_reason'='unconfirmed_status','pending never affects balance');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(24,'{"expected_version":"3","status":"rejected"}'))->>'review_reason'='unconfirmed_status','rejected never affects balance');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(25,'{"expected_version":"3","kind":"unknown","category":"other"}'))->>'review_reason'='unsupported_kind','ambiguous remains review');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(26,'{"expected_version":"3"}')-'amount')->>'review_reason'='missing_amount','missing amount remains review');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(27,'{"expected_version":"3"}')||jsonb_build_object('source',(pg_temp.fin_input(27)->'source')-'bank_transaction_id'))->>'review_reason'='missing_bank_transaction_id','no bank reference remains review');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(28,'{"expected_version":"3","occurred_at":"2026-01-01T16:00:00Z"}'))->>'review_reason'='before_import_start','historic notice blocked by explicit start');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(29,'{"expected_version":"3","account_id":"card-usd","currency":"USD","kind":"income","category":"other"}'))->>'review_reason'='credit_income_requires_review','credit income requires classification review');
select pg_temp.fin_assert(jsonb_array_length(pg_temp.fin_call('a','finance_list_movements','{"date_from":"2026-06-01","date_to":"2026-06-02"}')->'items')=3,'only two bank entries plus existing manual entry');
select pg_temp.fin_put('page',pg_temp.fin_call('a','finance_list_movements','{"date_from":"2026-06-01","date_to":"2026-06-02","limit":1}'));
select pg_temp.fin_assert(pg_temp.fin_get('page')->>'next_cursor' is not null,'movement pagination cursor');
select pg_temp.fin_assert(not (pg_temp.fin_get('page')->'items'->0)?'note','private notes never returned');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_list_movements','{"date_from":"2026-06-01","date_to":"2026-06-02","kind":"income"}')->'items'->0->>'amount'='55.12','exact decimal strings on reconciliation output');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_list_movements','{"date_from":"2026-01-01","date_to":"2026-12-31"}')$q$,'22023','reconciliation date window bounded');
select pg_temp.fin_put('reviews',pg_temp.fin_call('a','finance_list_reviews','{"limit":100}'));
select pg_temp.fin_assert(jsonb_array_length(pg_temp.fin_get('reviews')->'items')>=10,'agent can inspect allowed reviews');
select pg_temp.fin_assert(not (pg_temp.fin_get('reviews')->'items'->0)?'source','review output excludes opaque private source');

set local role authenticated;
select pg_temp.fin_actor(1);
select pg_temp.fin_assert(jsonb_array_length(public.tr8_mcp_finance_manage('list_reviews','{"limit":100}')->'items')=jsonb_array_length(pg_temp.fin_get('reviews')->'items'),'browser review listing');
select pg_temp.fin_assert(public.tr8_mcp_finance_manage('dismiss_review',jsonb_build_object('notice_id',pg_temp.fin_get('review_duplicate')->>'notice_id'))->>'status'='dismissed','browser can dismiss review without posting');
select pg_temp.fin_actor(2);
select pg_temp.fin_error($q$select public.tr8_mcp_finance_manage('dismiss_review',jsonb_build_object('notice_id',pg_temp.fin_get('review_duplicate')->>'notice_id'))$q$,'PT404','review dismissal owner isolated');
select pg_temp.fin_actor(1);
select pg_temp.fin_assert(public.tr8_mcp_finance_manage('revoke_grant','{"credential_id":"f9000030-0000-4000-8000-000000000003"}')->>'enabled'='false','browser can revoke finance only');
set local role anon;
select pg_temp.fin_error($q$select pg_temp.fin_call('c','finance_list_accounts')$q$,'PT403','revocation removes finance access');
reset role;
select pg_temp.fin_assert((select count(*)=2 from tr8_private.mcp_finance_notices where status='recorded'),'exactly two recorded notices');
select pg_temp.fin_assert((select count(*)=2 from tr8_private.mcp_finance_messages where notice_id=(pg_temp.fin_get('expense')->>'notice_id')::uuid),'same operation has two source aliases');
select pg_temp.fin_assert((select snapshot#>>'{financialSpace,domainSchemaVersion}'='5' from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'),'existing domain version preserved');
select pg_temp.fin_assert((select snapshot#>'{financialSpace,plans}'='[]'::jsonb from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'),'plans preserved');
select pg_temp.fin_assert((select to_jsonb(f)=pg_temp.fin_get('other_snapshot') from tr8_private.account_finances f where owner_id='f9000000-0000-4000-8000-000000000002'),'other owner finances byte-equivalent');
select pg_temp.fin_assert(not exists(select 1 from tr8_private.mcp_finance_requests where request_id='f9000020-0000-4000-8000-000000000005'),'version conflict creates no receipt');
update tr8_private.mcp_credentials set minute_count=0 where id::text like 'f9000030%';
set local role anon;
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"request_id":"f9000020-0000-4000-8000-000000000098","expected_version":"3","kind":"income","category":"other","amount":"20.20"}')||jsonb_build_object('source',(pg_temp.fin_input(1)->'source')||'{"message_id":"same_bank_different_kind"}'))->>'review_reason'='bank_reference_conflict','bank identity independent of guessed kind');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(30,'{"expected_version":"3","kind":"income","category":"refund"}'))->>'review_reason'='refund_requires_review','refund category never treated as automatic income');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(31,'{"expected_version":"3","amount":"1,23"}'))$q$,'22023','canonical protocol decimals require a dot');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(32,'{"expected_version":"3","amount":"01.23"}'))$q$,'22023','noncanonical leading zero rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(33,'{"expected_version":"3","occurred_at":"2026-06-01T24:00:00Z"}'))$q$,'22023','RFC3339 invalid hour rejected');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(34,'{"expected_version":"3","description":"OTP 123456"}'))$q$,'22023','OTP codes not stored');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(35,'{"expected_version":"3","description":"PIN: 1234"}'))$q$,'22023','PIN codes not stored');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(36,'{"expected_version":"3","description":"CVV 123"}'))$q$,'22023','card security codes not stored');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(37,'{"expected_version":"3","description":"Bearer synthetic-secret"}'))$q$,'22023','bearer credentials not stored');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(38,'{"expected_version":"3","description":"tr8_mcp_"}'))$q$,'22023','TR8 credential prefixes not stored');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(39,'{"expected_version":"3","description":"sb_secret_"}'))$q$,'22023','provider secret prefixes not stored');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(40,'{"expected_version":"3","description":"eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.c2lnbmF0dXJl"}'))$q$,'22023','JWT strings not stored');
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(41,'{"expected_version":"3","description":"Shopping"}')-'amount')->>'review_reason'='missing_amount','merchant word containing pin is not classified as credential');
reset role;
-- Stress arithmetic directly with the same actual SQL validator used to append.
select pg_temp.fin_put('saved_snapshot',(select snapshot from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'));
select pg_temp.fin_assert(not tr8_private.mcp_finance_balance_safe(jsonb_set(pg_temp.fin_get('saved_snapshot'),'{financialSpace,accounts,0,openingBalanceMinor}','9007199254740991')),'aggregate capacity overflow rejected even when each number is safe');
select pg_temp.fin_assert(not tr8_private.mcp_finance_balance_safe(jsonb_set(jsonb_set(pg_temp.fin_get('saved_snapshot'),'{financialSpace,accounts,0,openingBalanceMinor}','4503599627370496'),'{financialSpace,accounts}',
 (jsonb_set(pg_temp.fin_get('saved_snapshot'),'{financialSpace,accounts,0,openingBalanceMinor}','4503599627370496')#>'{financialSpace,accounts}')||
 '[{"id":"another-safe-balance","type":"cash","name":"Otra ficticia","currency":"DOP","openingBalanceMinor":4503599627370496,"openingDate":"2026-01-01"}]')),'individually safe account balances can overflow currency totals');
select pg_temp.fin_assert(not tr8_private.mcp_finance_balance_safe(jsonb_set(pg_temp.fin_get('saved_snapshot'),'{financialSpace,operations,0,amountMinor}','0.5')),'fractional minor ledger value rejected');
select pg_temp.fin_assert(not tr8_private.mcp_finance_balance_safe(jsonb_set(pg_temp.fin_get('saved_snapshot'),'{financialSpace,accounts,0,id}','null')),'malformed account fails closed');
select pg_temp.fin_assert(tr8_private.mcp_finance_balance_safe(pg_temp.fin_get('saved_snapshot')),'existing financial domain still accepted');
-- Include an existing legitimate FX card payment, without creating one through
-- this income/expense-only integration, then scope reconciliation to its USD leg.
update tr8_private.account_finances set snapshot=jsonb_set(snapshot,'{financialSpace,operations}',(snapshot#>'{financialSpace,operations}')||
 '[{"id":"fx-existing","kind":"card-payment","currency":"DOP","amountMinor":6000,"date":"2026-06-01","fromAccountId":"cash-dop","toAccountId":"card-usd","destinationCurrency":"USD","destinationAmountMinor":100,"description":"Pago ficticio FX","note":"No compartir"}]') where owner_id='f9000000-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.fin_put('fx_page',pg_temp.fin_call('a','finance_list_movements','{"date_from":"2026-06-01","date_to":"2026-06-02","account_id":"card-usd"}'));
select pg_temp.fin_assert(pg_temp.fin_get('fx_page')->'items'->0->>'currency'='USD' and pg_temp.fin_get('fx_page')->'items'->0->>'amount'='1.00','FX credit reconciliation returns requested destination amount');
reset role;
-- Restrict grant to the card only: the source account and source DOP amount must
-- no longer appear in this connection's reconciliation output.
delete from tr8_private.mcp_finance_accounts where credential_id='f9000030-0000-4000-8000-000000000001' and account_id='cash-dop';
set local role anon;
select pg_temp.fin_put('fx_only',pg_temp.fin_call('a','finance_list_movements','{"date_from":"2026-06-01","date_to":"2026-06-02"}'));
select pg_temp.fin_assert(pg_temp.fin_get('fx_only')->'items'->0->>'currency'='USD' and not (pg_temp.fin_get('fx_only')->'items'->0)?'from_account_id','FX source leg hidden when not authorized');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(50,'{"expected_version":"3"}'))$q$,'PT403','removed account grant denied even when owner still owns it');
reset role;
insert into tr8_private.mcp_finance_accounts values('f9000030-0000-4000-8000-000000000001','cash-dop','2026-01-02T00:00:00Z');
update tr8_private.account_finances set snapshot=pg_temp.fin_get('saved_snapshot') where owner_id='f9000000-0000-4000-8000-000000000001';
update tr8_private.mcp_credentials set expires_at=clock_timestamp()-interval '1 second' where id='f9000030-0000-4000-8000-000000000002';
set local role anon;
select pg_temp.fin_error($q$select pg_temp.fin_call('b','finance_context')$q$,'PT401','expired token denied');
reset role;
update tr8_private.app_users set enabled=false where user_id='f9000000-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_context')$q$,'PT403','disabled owner denied');
reset role;
update tr8_private.app_users set enabled=true where user_id='f9000000-0000-4000-8000-000000000001';
update tr8_private.workspace_members set status='removed' where workspace_id='f9000010-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_context')$q$,'PT403','inactive workspace membership denied');
reset role;
update tr8_private.workspace_members set status='active' where workspace_id='f9000010-0000-4000-8000-000000000001';
select pg_temp.fin_put('quota_before',(select to_jsonb(minute_count)from tr8_private.mcp_credentials where id='f9000030-0000-4000-8000-000000000001'));
set local role anon;
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(60,'{"expected_version":"3","currency":"EUR"}'))$q$,'22023','authorized failed validation still charges quota');
reset role;
select pg_temp.fin_assert((select minute_count=(pg_temp.fin_get('quota_before')#>>'{}')::integer+1 from tr8_private.mcp_credentials where id='f9000030-0000-4000-8000-000000000001'),'failed authorized call quota persists');
update tr8_private.mcp_credentials set minute_count=0 where id='f9000030-0000-4000-8000-000000000001';
-- Prior manual data may contain text that a new notice would reject. Only the
-- projection is redacted; reading through MCP must not rewrite that ledger.
do $$declare secret text; before_read jsonb; accounts jsonb; movements jsonb; projected_name text; projected_description text; begin
 foreach secret in array array['Bearer abcXYZ','tr8_mcp_synthetic','sb_secret_synthetic','OTP 123456','PIN 1234','CVV 123','eyJhbGci.eyJmaWVsZA.c2ln','Cuenta 1234567890123456'] loop
  update tr8_private.account_finances set snapshot=jsonb_set(jsonb_set(snapshot,'{financialSpace,accounts,0,name}',to_jsonb(secret)),'{financialSpace,operations,0,description}',to_jsonb(secret))
   where owner_id='f9000000-0000-4000-8000-000000000001' returning snapshot into before_read;
  accounts:=pg_temp.fin_call('a','finance_list_accounts');
  movements:=pg_temp.fin_call('a','finance_list_movements','{"date_from":"2026-06-01","date_to":"2026-06-02"}');
  select x->>'name' into projected_name from jsonb_array_elements(accounts->'items')x where x->>'id'='cash-dop';
  select x->>'description' into projected_description from jsonb_array_elements(movements->'items')x where x->>'id'='manual-old';
  perform pg_temp.fin_assert(projected_name like '%[omitido]%' and projected_description like '%[omitido]%','legacy sensitive account/concept redacted in MCP output');
  perform pg_temp.fin_assert((select snapshot=before_read from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'),'MCP redaction preserves original manual snapshot');
 end loop;
 update tr8_private.account_finances set snapshot=pg_temp.fin_get('saved_snapshot') where owner_id='f9000000-0000-4000-8000-000000000001';
end;$$;
update tr8_private.mcp_credentials set minute_count=60 where id='f9000030-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_context')$q$,'PT429','quota enforcement');
reset role;
-- A later GUI deletion/restoration does not delete the durable source receipt.
update tr8_private.account_finances set snapshot=jsonb_set(snapshot,'{financialSpace,operations}',(select jsonb_agg(x)from jsonb_array_elements(snapshot#>'{financialSpace,operations}')x where x->>'id'<>pg_temp.fin_get('expense')->>'operation_id')),version=version+1 where owner_id='f9000000-0000-4000-8000-000000000001';
update tr8_private.mcp_credentials set minute_count=0 where id::text like 'f9000030%';
set local role anon;
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20"}'))=pg_temp.fin_get('expense'),'deleted movement not re-created by retry');
reset role;
select pg_temp.fin_assert((select jsonb_array_length(snapshot#>'{financialSpace,operations}')=2 from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'),'tombstone retry leaves deleted ledger unchanged');
select pg_temp.fin_put('capacity_snapshot',(select snapshot from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'));
-- Exercise actual per-owner hard limits using small, purely synthetic rows.
-- Cleanup below removes only these test fixtures, never integration history.
insert into tr8_private.mcp_finance_notices(id,owner_id,account_id,kind,bank_status,financial_hash,canonical,status,review_reason,result)
select ('f9000040-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'f9000000-0000-4000-8000-000000000001','cash-dop','unknown','unknown',repeat('0',64),'{}','review','missing_amount','{}'
from generate_series(1,10000-(select count(*)::integer from tr8_private.mcp_finance_notices where owner_id='f9000000-0000-4000-8000-000000000001'))n;
set local role anon;
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20"}'))=pg_temp.fin_get('expense'),'stable request replay works at notice capacity');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(95,'{"expected_version":"4"}'))$q$,'PT429','notice storage capacity blocks new writes');
reset role;
select pg_temp.fin_assert((select snapshot=pg_temp.fin_get('capacity_snapshot') from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'),'notice capacity preserves exact ledger');
delete from tr8_private.mcp_finance_notices where id::text like 'f9000040-%';
insert into tr8_private.mcp_finance_messages(owner_id,mailbox_id,message_id,notice_id,payload_hash)
select 'f9000000-0000-4000-8000-000000000001',repeat('c',64),'capacity_fixture_'||n,(pg_temp.fin_get('expense')->>'notice_id')::uuid,repeat('0',64)
from generate_series(1,20000-(select count(*)::integer from tr8_private.mcp_finance_messages where owner_id='f9000000-0000-4000-8000-000000000001'))n;
set local role anon;
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20"}'))=pg_temp.fin_get('expense'),'stable request replay works at message capacity');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(95,'{"expected_version":"4"}'))$q$,'PT429','message storage capacity blocks new aliases');
reset role;
select pg_temp.fin_assert((select snapshot=pg_temp.fin_get('capacity_snapshot') from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'),'message capacity preserves exact ledger');
delete from tr8_private.mcp_finance_messages where owner_id='f9000000-0000-4000-8000-000000000001' and mailbox_id=repeat('c',64) and message_id like 'capacity_fixture_%';
insert into tr8_private.mcp_finance_requests(owner_id,request_id,notice_id,payload_hash,result)
select 'f9000000-0000-4000-8000-000000000001',('f9000050-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,(pg_temp.fin_get('expense')->>'notice_id')::uuid,repeat('0',64),'{}'
from generate_series(1,30000-(select count(*)::integer from tr8_private.mcp_finance_requests where owner_id='f9000000-0000-4000-8000-000000000001'))n;
set local role anon;
select pg_temp.fin_assert(pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(1,'{"amount":"20.20"}'))=pg_temp.fin_get('expense'),'stable request replay works at request capacity');
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_submit_notice',pg_temp.fin_input(95,'{"expected_version":"4"}'))$q$,'PT429','request storage capacity blocks new receipts');
reset role;
select pg_temp.fin_assert((select snapshot=pg_temp.fin_get('capacity_snapshot') from tr8_private.account_finances where owner_id='f9000000-0000-4000-8000-000000000001'),'request capacity preserves exact ledger');
delete from tr8_private.mcp_finance_requests where owner_id='f9000000-0000-4000-8000-000000000001' and request_id::text like 'f9000050-%';
update tr8_private.mcp_credentials set revoked_at=clock_timestamp() where id='f9000030-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.fin_error($q$select pg_temp.fin_call('a','finance_context')$q$,'PT401','MCP bearer revocation still authoritative');
reset role;
select current_setting('tr8.finance_test_checks')::integer checks;
rollback;
