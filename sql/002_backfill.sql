alter table motion_events
  add column if not exists sequence bigint;

alter table device_logs
  add column if not exists sequence bigint;

create unique index if not exists motion_events_device_sequence_idx
  on motion_events (device_id, sequence)
  where sequence is not null;

create unique index if not exists device_logs_device_sequence_idx
  on device_logs (device_id, sequence)
  where sequence is not null;

create table if not exists device_sync_state (
  device_id text primary key references devices (id) on delete cascade,
  last_acked_sequence bigint not null default 0,
  last_acked_boot_id text,
  last_sync_completed_at timestamptz,
  last_overflow_detected_at timestamptz,
  updated_at timestamptz not null default now()
);
