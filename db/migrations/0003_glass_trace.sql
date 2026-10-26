-- GLASS/UNISON trace transport: append-only derived telemetry.
-- Existing ACSP events/checkpoints untouched.
create table if not exists glass_trace_events (
  seq bigserial primary key,
  room_id varchar(64) not null,
  client_event_id varchar(96) not null,
  kind varchar(32) not null check (kind in ('audio.trace','language.candidate','language.confirmed','session.state','trace.drop')),
  features jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (room_id, client_event_id),
  constraint glass_features_object check (jsonb_typeof(features)='object')
);
create index if not exists glass_trace_room_order_idx on glass_trace_events(room_id,seq);
create index if not exists glass_trace_room_time_idx on glass_trace_events(room_id,recorded_at);
create or replace function glass_trace_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'GLASS trace events are append-only';
end $$;
drop trigger if exists glass_trace_append_only on glass_trace_events;
create trigger glass_trace_append_only before update or delete on glass_trace_events
  for each row execute function glass_trace_immutable();
comment on table glass_trace_events is 'Opt-in, privately authorized, bounded numeric telemetry; never raw audio/text; only derived events.';
