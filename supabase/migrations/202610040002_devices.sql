begin;
create table public.pos_backup_devices (
  owner_id uuid not null references auth.users(id) on delete restrict,
  device_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (owner_id, device_id)
);
alter table public.pos_backup_devices enable row level security;
revoke all on public.pos_backup_devices from public, anon, authenticated;
grant select on public.pos_backup_devices to authenticated;
create policy pos_devices_read_own on public.pos_backup_devices
  for select to authenticated using ((select auth.uid()) = owner_id);
create function public.pos_register_device(p_device_id uuid, p_name text)
returns public.pos_backup_devices language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid := auth.uid(); v_device public.pos_backup_devices;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.pos_backup_devices(owner_id, device_id, name)
    values(v_owner, p_device_id, btrim(p_name))
    on conflict(owner_id, device_id) do update set name = excluded.name, last_seen_at = now()
    returning * into v_device;
  return v_device;
end;
$$;
revoke all on function public.pos_register_device(uuid, text) from public, anon, authenticated;
grant execute on function public.pos_register_device(uuid, text) to authenticated;
-- Historical uploads from schema v1 retain their IDs and receive a placeholder name.
insert into public.pos_backup_devices(owner_id, device_id, name)
  select distinct owner_id, source_device_id, '旧端末（名称未登録）' from public.pos_backup_orders
  on conflict do nothing;
insert into public.pos_backup_devices(owner_id, device_id, name)
  select owner_id, source_device_id, '旧端末（名称未登録）' from public.pos_backup_settings
  on conflict do nothing;
alter table public.pos_backup_orders add constraint pos_order_device_fk
  foreign key(owner_id, source_device_id) references public.pos_backup_devices(owner_id, device_id);
alter table public.pos_backup_settings add constraint pos_price_device_fk
  foreign key(owner_id, source_device_id) references public.pos_backup_devices(owner_id, device_id);
commit;
