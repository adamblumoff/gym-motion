drop table if exists motion_events;
drop table if exists devices;

create table if not exists devices (
  id text primary key,
  last_state text not null,
  last_seen_at bigint not null,
  last_delta integer,
  updated_at timestamp not null default now()
);

create table if not exists motion_events (
  id bigserial primary key,
  device_id text not null,
  state text not null,
  delta integer,
  event_timestamp bigint not null,
  received_at timestamp not null default now()
);

create index if not exists motion_events_device_id_idx
  on motion_events (device_id, event_timestamp desc);
