-- Run after installing Stage 4A on the disposable test project.
-- Two assertions; no fixtures, writes or sequence allocation.
begin isolation level repeatable read;
do $$ begin
  begin
    perform tr8_private.v4_claim_jobs(1);
    raise exception 'Assertion failed: claim accepted repeatable read';
  exception when sqlstate '25000' then null; end;
  begin
    perform tr8_private.v4_finish_job(gen_random_uuid(),gen_random_uuid(),'succeeded');
    raise exception 'Assertion failed: finish accepted repeatable read';
  exception when sqlstate '25000' then null; end;
end; $$;
select 2 as stage4_isolation_assertions;
rollback;
