create index if not exists motion_events_device_event_timestamp_idx
  on motion_events (device_id, event_timestamp desc);
