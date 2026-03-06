drop table if exists motion_events;
drop table if exists firmware_releases;
drop table if exists devices;

create table if not exists devices (
  id text primary key,
  last_state text not null default 'still',
  last_seen_at bigint not null default 0,
  last_delta integer,
  updated_at timestamp not null default now(),
  hardware_id text,
  boot_id text,
  firmware_version text not null default 'unknown',
  machine_label text,
  site_id text,
  provisioning_state text not null default 'unassigned',
  update_status text not null default 'idle',
  last_event_received_at timestamp,
  last_heartbeat_at timestamp,
  wifi_provisioned_at timestamp
);

create table if not exists motion_events (
  id bigserial primary key,
  device_id text not null references devices (id) on delete cascade,
  state text not null,
  delta integer,
  event_timestamp bigint not null,
  received_at timestamp not null default now(),
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
  created_at timestamp not null default now()
);

create index if not exists devices_updated_at_idx
  on devices (updated_at desc);

create index if not exists devices_site_id_idx
  on devices (site_id, machine_label);

create index if not exists motion_events_device_id_idx
  on motion_events (device_id, received_at desc);

create index if not exists firmware_releases_rollout_state_idx
  on firmware_releases (rollout_state, created_at desc);
