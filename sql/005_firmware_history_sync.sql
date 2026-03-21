create table if not exists firmware_history_sync_state (
  device_id text primary key references devices (id) on delete cascade,
  last_acked_history_sequence bigint not null default 0,
  last_history_sync_completed_at timestamptz,
  last_history_overflow_detected_at timestamptz,
  updated_at timestamptz not null default now()
);
