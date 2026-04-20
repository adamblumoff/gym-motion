alter table devices
  add column if not exists last_gateway_id text,
  add column if not exists last_gateway_seen_at timestamptz;

create index if not exists devices_last_gateway_id_idx
  on devices (last_gateway_id, last_gateway_seen_at);

alter table motion_events
  add column if not exists gateway_id text;

create index if not exists motion_events_gateway_id_idx
  on motion_events (gateway_id, received_at);

alter table device_logs
  add column if not exists gateway_id text;

create index if not exists device_logs_gateway_id_idx
  on device_logs (gateway_id, received_at);
