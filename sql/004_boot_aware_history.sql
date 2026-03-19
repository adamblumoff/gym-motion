drop index if exists motion_events_device_sequence_idx;
drop index if exists device_logs_device_sequence_idx;

create unique index if not exists motion_events_device_boot_sequence_idx
  on motion_events (device_id, coalesce(boot_id, ''), sequence)
  where sequence is not null;

create unique index if not exists device_logs_device_boot_sequence_idx
  on device_logs (device_id, coalesce(boot_id, ''), sequence)
  where sequence is not null;

alter table device_sync_state
  add column if not exists boot_id text not null default '';

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'device_sync_state'
      and constraint_type = 'PRIMARY KEY'
      and constraint_name = 'device_sync_state_pkey'
  ) then
    alter table device_sync_state
      drop constraint device_sync_state_pkey;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'device_sync_state'
      and constraint_type = 'PRIMARY KEY'
      and constraint_name = 'device_sync_state_pkey'
  ) then
    alter table device_sync_state
      add constraint device_sync_state_pkey primary key (device_id, boot_id);
  end if;
end
$$;
