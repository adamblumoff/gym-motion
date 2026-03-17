create table if not exists device_history_watermarks (
  device_id text primary key references devices (id) on delete cascade,
  deleted_before timestamptz not null,
  updated_at timestamptz not null default now()
);
