-- Synthetic RPC test. No permanent objects are created; every fixture rolls back.
begin;
do $$
declare
 actor uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); before_digest text;
 v4 jsonb:='{"schemaVersion":1,"financialSpace":{"domainSchemaVersion":4,"currencyCatalogVersion":"currency-catalog-v1","currencyDefinitions":[],"accounts":[],"operations":[],"plans":[]}}';
 v5 jsonb:='{"schemaVersion":1,"financialSpace":{"domainSchemaVersion":5,"currencyCatalogVersion":"currency-catalog-v1","currencyDefinitions":[{"code":"DOP","minorUnitDigits":2},{"code":"USD","minorUnitDigits":2}],"accounts":[{"id":"saving","name":"Synthetic savings","type":"debit","currency":"DOP","openingBalanceMinor":1000000,"openingDate":"2026-01-01"},{"id":"card","name":"Synthetic card","type":"credit","currency":"USD","openingBalanceMinor":30000,"creditLimitMinor":100000,"openingDate":"2026-01-01"}],"operations":[{"id":"payment","kind":"card-payment","currency":"DOP","amountMinor":600000,"destinationCurrency":"USD","destinationAmountMinor":10000,"fromAccountId":"saving","toAccountId":"card","date":"2026-10-30","description":"Synthetic FX payment","note":""}],"plans":[]}}';
begin
 select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) into before_digest from tr8_private.account_finances f;
 insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values(actor,'authenticated','authenticated','fx-'||actor::text||'@example.test',now(),'{}','{}',now(),now()),
 (other_actor,'authenticated','authenticated','fx-'||other_actor::text||'@example.test',now(),'{}','{}',now(),now());
 insert into tr8_private.app_users(user_id,enabled,display_name) values(actor,true,'Synthetic FX test'),(other_actor,true,'Synthetic FX other');
 insert into auth.sessions(id,user_id,created_at,updated_at) values(sid,actor,now(),now());
 perform set_config('request.jwt.claim','',true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','session_id',sid)::text,true);
 set local role authenticated;
 if public.tr8_account_finance(v4,'0','71d08900-0000-4000-8000-000000000001')->>'version'<>'1' then raise exception 'FX: v4 write failed'; end if;
 if public.tr8_account_finance(v5,'1','71d08900-0000-4000-8000-000000000002')->>'version'<>'2' then raise exception 'FX: v5 write failed'; end if;
 if public.tr8_account_finance(v5,'1','71d08900-0000-4000-8000-000000000002')->>'version'<>'2' then raise exception 'FX: retry failed'; end if;
 if public.tr8_account_finance()->'snapshot' is distinct from v5 then raise exception 'FX: roundtrip failed'; end if;
 begin perform public.tr8_account_finance(v4,'2','71d08900-0000-4000-8000-000000000003'); raise exception 'FX: downgrade allowed'; exception when sqlstate 'PT400' then null; end;
 begin perform public.tr8_account_finance(v5,'1','71d08900-0000-4000-8000-000000000004'); raise exception 'FX: stale version allowed'; exception when sqlstate 'PT409' then null; end;
 begin perform public.tr8_account_finance(v4,'1','71d08900-0000-4000-8000-000000000002'); raise exception 'FX: changed retry allowed'; exception when sqlstate 'PT409' then null; end;
 begin perform public.tr8_account_finance(jsonb_set(v5,'{financialSpace,domainSchemaVersion}','null'),'2','71d08900-0000-4000-8000-000000000005'); raise exception 'FX: null version allowed'; exception when sqlstate 'PT400' then null; end;
 begin perform public.tr8_account_finance(jsonb_set(v5,'{financialSpace,domainSchemaVersion}','6'),'2','71d08900-0000-4000-8000-000000000006'); raise exception 'FX: unknown version allowed'; exception when sqlstate 'PT400' then null; end;
 perform set_config('request.jwt.claim.sub',other_actor::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_actor,'role','authenticated','session_id',sid)::text,true);
 begin perform public.tr8_account_finance(); raise exception 'FX: another actor reused session'; exception when sqlstate '42501' then null; end;
 set local role anon;
 begin perform public.tr8_account_finance(); raise exception 'FX: anonymous read allowed'; exception when sqlstate '42501' then null; end;
 reset role;
 if before_digest is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where owner_id<>actor)
 then raise exception 'FX: existing documents changed'; end if;
end;$$;
rollback;
select 'FX RPC compatibility and authorization checks passed; fixtures rolled back' as result;
