create table if not exists motion_rollups_hourly (
  device_id text not null references devices (id) on delete cascade,
  bucket_start bigint not null,
  movement_count integer not null,
  moving_seconds integer not null,
  updated_at timestamptz not null default now(),
  primary key (device_id, bucket_start)
);

create table if not exists motion_rollups_daily (
  device_id text not null references devices (id) on delete cascade,
  bucket_start bigint not null,
  movement_count integer not null,
  moving_seconds integer not null,
  updated_at timestamptz not null default now(),
  primary key (device_id, bucket_start)
);

create index if not exists motion_rollups_hourly_bucket_idx
  on motion_rollups_hourly (bucket_start desc);

create index if not exists motion_rollups_daily_bucket_idx
  on motion_rollups_daily (bucket_start desc);
