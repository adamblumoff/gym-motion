drop table if exists motion_events;
drop table if exists device_logs;
drop table if exists firmware_releases;
drop table if exists device_sync_state;
drop table if exists devices;

create table if not exists devices (
  id text primary key,
  last_state text not null default 'still',
  last_seen_at bigint not null default 0,
  last_delta integer,
  updated_at timestamptz not null default now(),
  hardware_id text,
  boot_id text,
  firmware_version text not null default 'unknown',
  machine_label text,
  site_id text,
  provisioning_state text not null default 'unassigned',
  update_status text not null default 'idle',
  update_target_version text,
  update_detail text,
  update_reported_at timestamptz,
  last_event_received_at timestamptz,
  last_heartbeat_at timestamptz,
  wifi_provisioned_at timestamptz
);

create table if not exists motion_events (
  id bigserial primary key,
  device_id text not null references devices (id) on delete cascade,
  sequence bigint,
  state text not null,
  delta integer,
  event_timestamp bigint not null,
  received_at timestamptz not null default now(),
  boot_id text,
  firmware_version text,
  hardware_id text
);

create table if not exists firmware_releases (
  version text primary key,
  git_sha text not null,
  asset_url text not null,
  sha256 text not null,
  md5 text,
  size_bytes bigint not null,
  rollout_state text not null default 'draft',
  created_at timestamptz not null default now()
);

create table if not exists device_logs (
  id bigserial primary key,
  device_id text not null,
  sequence bigint,
  level text not null,
  code text not null,
  message text not null,
  boot_id text,
  firmware_version text,
  hardware_id text,
  device_timestamp bigint,
  metadata jsonb,
  received_at timestamptz not null default now()
);

create index if not exists devices_updated_at_idx
  on devices (updated_at desc);

create index if not exists devices_site_id_idx
  on devices (site_id, machine_label);

create index if not exists motion_events_device_id_idx
  on motion_events (device_id, received_at desc);

create unique index if not exists motion_events_device_boot_sequence_idx
  on motion_events (device_id, coalesce(boot_id, ''), sequence)
  where sequence is not null;

create index if not exists firmware_releases_rollout_state_idx
  on firmware_releases (rollout_state, created_at desc);

create index if not exists device_logs_device_id_idx
  on device_logs (device_id, received_at desc);

create index if not exists device_logs_received_at_idx
  on device_logs (received_at desc);

create unique index if not exists device_logs_device_boot_sequence_idx
  on device_logs (device_id, coalesce(boot_id, ''), sequence)
  where sequence is not null;

create table if not exists device_sync_state (
  device_id text not null references devices (id) on delete cascade,
  boot_id text not null default '',
  last_acked_sequence bigint not null default 0,
  last_acked_boot_id text,
  last_sync_completed_at timestamptz,
  last_overflow_detected_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (device_id, boot_id)
);
