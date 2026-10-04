-- zansin学祭POS / Supabase backup schema
-- Run once in Supabase SQL Editor as postgres. No existing data is deleted.
-- Same permanent Auth account on the replacement iPad; no realtime sync.
begin;

create table public.pos_backup_orders (
  owner_id uuid not null references auth.users(id) on delete restrict,
  order_id uuid not null,
  source_device_id uuid not null,
  source_local_id bigint not null check (source_local_id between 1 and 9007199254740991),
  ordered_at_ms bigint not null check (ordered_at_ms between 0 and 8640000000000000),
  unit_price integer not null check (unit_price between 1 and 999999),
  quantity integer not null check (quantity between 1 and 999),
  amount integer generated always as (unit_price * quantity) stored,
  is_active boolean not null default true,
  backed_up_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, order_id),
  unique (owner_id, source_device_id, source_local_id)
);
create index pos_backup_orders_history
  on public.pos_backup_orders (owner_id, ordered_at_ms desc, order_id);

create table public.pos_backup_settings (
  owner_id uuid primary key references auth.users(id) on delete restrict,
  current_unit_price integer not null check (current_unit_price between 1 and 999999),
  revision bigint not null check (revision between 1 and 9007199254740991),
  mutation_id uuid not null,
  source_device_id uuid not null,
  updated_at timestamptz not null default now()
);

alter table public.pos_backup_orders enable row level security;
alter table public.pos_backup_settings enable row level security;
revoke all on table public.pos_backup_orders, public.pos_backup_settings from public, anon, authenticated;
grant select on table public.pos_backup_orders, public.pos_backup_settings to authenticated;
create policy pos_orders_read_own on public.pos_backup_orders
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy pos_settings_read_own on public.pos_backup_settings
  for select to authenticated using ((select auth.uid()) = owner_id);

-- Writes go through RPC only so direct UPDATE cannot restore cancelled orders.
-- Definer is necessary for these controlled writes; never trust a client owner_id.
create function public.pos_backup_order(
  p_order_id uuid,
  p_source_device_id uuid,
  p_source_local_id bigint,
  p_ordered_at_ms bigint,
  p_unit_price integer,
  p_quantity integer,
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
    (owner_id, order_id, source_device_id, source_local_id, ordered_at_ms, unit_price, quantity, is_active)
  values
    (v_owner, p_order_id, p_source_device_id, p_source_local_id, p_ordered_at_ms, p_unit_price, p_quantity, p_is_active)
  on conflict (owner_id, order_id) do update
    set is_active = existing.is_active and excluded.is_active,
        updated_at = case when existing.is_active and not excluded.is_active then now() else existing.updated_at end
    where existing.source_device_id = excluded.source_device_id
      and existing.source_local_id = excluded.source_local_id
      and existing.ordered_at_ms = excluded.ordered_at_ms
      and existing.unit_price = excluded.unit_price
      and existing.quantity = excluded.quantity
  returning * into v_order;

  if not found then
    raise exception 'Order identity or immutable sale fields do not match' using errcode = '22023';
  end if;
  return v_order;
end;
$$;

-- Compare-and-swap prevents a replaced iPad from overwriting a newer price.
-- Retry a request with the SAME mutation_id and expected_revision.
create function public.pos_backup_price(
  p_current_unit_price integer,
  p_expected_revision bigint,
  p_mutation_id uuid,
  p_source_device_id uuid
) returns public.pos_backup_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_settings public.pos_backup_settings;
begin
  if v_owner is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_current_unit_price is null or p_current_unit_price not between 1 and 999999
    or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990
    or p_mutation_id is null or p_source_device_id is null then
    raise exception 'Invalid price backup parameters' using errcode = '22023';
  end if;

  -- Serialize only this owner's price writes, including the first insert.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 0));
  select * into v_settings from public.pos_backup_settings where owner_id = v_owner for update;
  if found then
    if v_settings.mutation_id = p_mutation_id then
      if v_settings.current_unit_price <> p_current_unit_price
        or v_settings.source_device_id <> p_source_device_id
        or v_settings.revision <> p_expected_revision + 1 then
        raise exception 'Mutation ID reused with different data' using errcode = '22023';
      end if;
      return v_settings;
    end if;
    if v_settings.revision <> p_expected_revision then
      raise exception 'Price backup revision conflict; fetch the latest backup before retrying' using errcode = '40001';
    end if;
    update public.pos_backup_settings
      set current_unit_price = p_current_unit_price, revision = revision + 1,
          mutation_id = p_mutation_id, source_device_id = p_source_device_id, updated_at = now()
      where owner_id = v_owner returning * into v_settings;
  else
    if p_expected_revision <> 0 then
      raise exception 'Initial price backup requires revision 0' using errcode = '40001';
    end if;
    insert into public.pos_backup_settings
      (owner_id, current_unit_price, revision, mutation_id, source_device_id)
      values (v_owner, p_current_unit_price, 1, p_mutation_id, p_source_device_id)
      returning * into v_settings;
  end if;
  return v_settings;
end;
$$;

revoke all on function public.pos_backup_order(uuid, uuid, bigint, bigint, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.pos_backup_price(integer, bigint, uuid, uuid) from public, anon, authenticated;
grant execute on function public.pos_backup_order(uuid, uuid, bigint, bigint, integer, integer, boolean) to authenticated;
grant execute on function public.pos_backup_price(integer, bigint, uuid, uuid) to authenticated;

comment on table public.pos_backup_orders is 'Append sales and make cancellation permanent. No client delete or arbitrary update.';
comment on table public.pos_backup_settings is 'Latest backed-up unit price; revision prevents stale replacement-device writes.';
commit;
