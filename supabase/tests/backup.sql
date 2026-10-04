-- Run after migration, in a DEVELOPMENT Supabase SQL Editor as postgres.
-- All fixture data is rolled back. On any error, run ROLLBACK if needed.
begin;
insert into auth.users(id) values
  ('b0ca0000-0000-4000-8000-000000000001'),
  ('b0ca0000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b0ca0000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b0ca0000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare
  o public.pos_backup_orders;
  s public.pos_backup_settings;
  oid uuid := 'b0ca1000-0000-4000-8000-000000000001';
  did uuid := 'b0ca2000-0000-4000-8000-000000000001';
  mid uuid := 'b0ca3000-0000-4000-8000-000000000001';
begin
  perform public.pos_register_device(did, 'テスト端末A');
  o := public.pos_backup_order(oid,did,1,1791000000000,300,3,true);
  if o.amount <> 900 then raise exception 'Wrong amount'; end if;
  perform public.pos_backup_order(oid,did,1,1791000000000,300,3,true);
  if (select count(*) from public.pos_backup_orders) <> 1 then raise exception 'Duplicate sale'; end if;
  perform public.pos_backup_order(oid,did,1,1791000000000,300,3,false);
  o := public.pos_backup_order(oid,did,1,1791000000000,300,3,true);
  if o.is_active then raise exception 'Cancellation resurrected'; end if;
  begin
    perform public.pos_backup_order(oid,did,1,1791000000000,350,3,true);
    raise exception 'Immutable price was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.pos_backup_order('b0ca1000-0000-4000-8000-000000000002',did,1,1791000000000,300,3,true);
    raise exception 'Same source sale with new UUID was accepted';
  exception when unique_violation then null;
  end;
  begin
    perform public.pos_backup_order('b0ca1000-0000-4000-8000-000000000003',did,3,1791000000000,300,0,true);
    raise exception 'Invalid quantity was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.pos_backup_orders set is_active = true;
    raise exception 'Direct update was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.pos_backup_orders;
    raise exception 'Direct delete was accepted';
  exception when insufficient_privilege then null;
  end;
  s := public.pos_backup_price(300,0,mid,did);
  s := public.pos_backup_price(300,0,mid,did);
  if s.revision <> 1 then raise exception 'Price retry increments revision'; end if;
  s := public.pos_backup_price(350,1,'b0ca3000-0000-4000-8000-000000000002',did);
  if s.revision <> 2 then raise exception 'Price revision did not advance'; end if;
  begin
    perform public.pos_backup_price(300,0,mid,did);
    raise exception 'Stale price was accepted';
  exception when serialization_failure then null;
  end;
end;
$$;

-- Second owner must not see or cancel the first owner's order.
select set_config('request.jwt.claim.sub', 'b0ca0000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b0ca0000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
begin
  if exists(select 1 from public.pos_backup_orders) or exists(select 1 from public.pos_backup_settings) then
    raise exception 'Cross-owner read allowed';
  end if;
  perform public.pos_register_device('b0ca2000-0000-4000-8000-000000000001', 'テスト端末B');
  perform public.pos_backup_order('b0ca1000-0000-4000-8000-000000000001',
    'b0ca2000-0000-4000-8000-000000000001',1,1791000000000,300,3,true);
end;
$$;
reset role;
do $$
begin
  if (select is_active from public.pos_backup_orders
      where owner_id = 'b0ca0000-0000-4000-8000-000000000001') then
    raise exception 'Cross-owner write changed original sale';
  end if;
end;
$$;

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
do $$
begin
  begin
    perform 1 from public.pos_backup_orders;
    raise exception 'Anonymous read allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.pos_backup_order('b0ca1000-0000-4000-8000-000000000001',
      'b0ca2000-0000-4000-8000-000000000001',1,1791000000000,300,3,true);
    raise exception 'Anonymous RPC allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
rollback;
select 'PASS: retries, cancellation, validation, price revisions, RLS and grants' as result;
