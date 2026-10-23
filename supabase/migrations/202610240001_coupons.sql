-- Zansin学祭POS / Coupons: each coupon takes 50 yen off one set.
-- Run once in Supabase SQL Editor as postgres, BEFORE deploying the app version with coupons.
-- Existing rows get coupon_count = 0, so their amounts do not change.
begin;

alter table public.pos_backup_orders
  add column coupon_count integer not null default 0;
alter table public.pos_backup_orders
  add constraint pos_order_coupon_count check (coupon_count between 0 and quantity);
-- amount = unit price × sets − 50 yen per applied coupon (kept in sync with logic.js COUPON_DISCOUNT).
alter table public.pos_backup_orders drop column amount;
alter table public.pos_backup_orders
  add column amount integer generated always as (unit_price * quantity - 50 * coupon_count) stored;
alter table public.pos_backup_orders
  add constraint pos_order_amount_not_negative check (unit_price * quantity - 50 * coupon_count >= 0);

-- Same contract as pos_backup_order plus p_coupon_count, which is immutable like the other sale fields.
-- The 7-argument version stays for app versions without coupons (coupon_count defaults to 0).
create function public.pos_backup_order(
  p_order_id uuid,
  p_source_device_id uuid,
  p_source_local_id bigint,
  p_ordered_at_ms bigint,
  p_unit_price integer,
  p_quantity integer,
  p_coupon_count integer,
  p_is_active boolean
) returns public.pos_backup_orders
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_order public.pos_backup_orders;
begin
  if v_owner is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  insert into public.pos_backup_orders as existing
    (owner_id, order_id, source_device_id, source_local_id, ordered_at_ms, unit_price, quantity, coupon_count, is_active)
  values
    (v_owner, p_order_id, p_source_device_id, p_source_local_id, p_ordered_at_ms, p_unit_price, p_quantity, p_coupon_count, p_is_active)
  on conflict (owner_id, order_id) do update
    set is_active = existing.is_active and excluded.is_active,
        updated_at = case when existing.is_active and not excluded.is_active then now() else existing.updated_at end
    where existing.source_device_id = excluded.source_device_id
      and existing.source_local_id = excluded.source_local_id
      and existing.ordered_at_ms = excluded.ordered_at_ms
      and existing.unit_price = excluded.unit_price
      and existing.quantity = excluded.quantity
      and existing.coupon_count = excluded.coupon_count
  returning * into v_order;

  if not found then
    raise exception 'Order identity or immutable sale fields do not match' using errcode = '22023';
  end if;
  return v_order;
end;
$$;
revoke all on function public.pos_backup_order(uuid, uuid, bigint, bigint, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.pos_backup_order(uuid, uuid, bigint, bigint, integer, integer, integer, boolean) to authenticated;

commit;
