-- Disposable TEST only, after the candidate migration is present.
begin isolation level repeatable read;
do $$ begin
  begin perform tr8_private.v5_claim(1);raise exception 'claim accepted repeatable read';
  exception when sqlstate '25000' then null;end;
  begin perform tr8_private.v5_prepare(gen_random_uuid(),gen_random_uuid());raise exception 'prepare accepted repeatable read';
  exception when sqlstate '25000' then null;end;
  begin perform tr8_private.v5_finish(gen_random_uuid(),gen_random_uuid(),'{"outcome":"succeeded"}');raise exception 'finish accepted repeatable read';
  exception when sqlstate '25000' then null;end;
  begin perform tr8_private.v5_reserve_request(null,null,'{"purpose":"oauth"}');raise exception 'reserve accepted repeatable read';
  exception when sqlstate '25000' then null;end;
  begin perform tr8_private.v5_server('status');raise exception 'server accepted repeatable read';
  exception when sqlstate '25000' then null;end;
end; $$;
select 5 as assertions_passed,'Google isolation fences passed' as result;
rollback;
