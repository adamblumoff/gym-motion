alter table devices
  add column if not exists update_target_version text;

alter table devices
  add column if not exists update_detail text;

alter table devices
  add column if not exists update_reported_at timestamptz;
