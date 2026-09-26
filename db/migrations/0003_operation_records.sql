-- ACSP/0.2: operations become first-class, addressable records.
--
-- An OPERATION is one accepted mutation request. It produces one or more
-- EVENTS (resolve_proposal produces two). ACSP/0.1 treated the event log as
-- the operation log; that cannot give a two-event request one identity, so
-- 0.2 records operations separately and links each event to its operation.
--
-- Operations are append-only, like events and checkpoints. Resources created
-- before this migration have events without operation records ("legacy").

create table operations (
  resource_id          text not null references resources (id),
  id                   text not null unique,          -- op-XXXXXXXXXXXXXXXX (server-generated)
  seq                  integer not null,              -- 1, 2, … per resource
  operation            text not null,                 -- core name ("append") or extension ("ext:ns:name")
  definition_version   text not null,                 -- "core@ACSP/0.1" or the extension's version
  protocol             text not null,                 -- protocol the envelope declared
  actor                jsonb not null,                -- { session_id, agent_id, kind }
  identity_assurance   text not null check (identity_assurance in ('capability', 'asserted')),
  capability_id        text,
  authority            jsonb not null,                -- { via, capability_id, capability_kind, scopes }
  requested_by         jsonb not null,                -- the proposer for proposal executions, else the actor
  on_behalf_of         jsonb,
  proposal_id          text,
  expected_version     integer,
  from_version         integer not null,              -- version before (0 for create/fork)
  to_version           integer not null,              -- version after
  state_before         text,                          -- sha256 of the operational state before (null for create/fork)
  state_after          text not null,                 -- sha256 of the operational state after
  parent_operation_id  text,                          -- previous operation on this resource (server)
  causation_id         text,                          -- operation this one responds to (validated)
  causation_source     text check (causation_source in ('actor', 'derived')),
  correlation_id       text not null,                 -- workflow id (actor-supplied, inherited, or own id)
  request_hash         text not null,
  idempotency_key      text not null,
  payload              jsonb not null,
  result               jsonb not null,                -- secrets redacted
  created_at           timestamptz not null,
  primary key (resource_id, id),
  unique (resource_id, seq),
  check (to_version > from_version)
);
create index operations_correlation on operations (resource_id, correlation_id);
create index operations_causation on operations (resource_id, causation_id);

create trigger operations_append_only
  before update or delete on operations
  for each row execute function acsp_forbid_history_mutation();

alter table events add column operation_id text;
create index events_operation on events (resource_id, operation_id);

-- A proposal records the operation that created it and a hash binding its payload.
alter table proposals add column operation_id text;
alter table proposals add column payload_sha256 text;
alter table proposals add column base_version integer;

-- Extensions the owner has enabled on this resource (names from the service's registry).
alter table resources add column enabled_extensions text[] not null default '{}';

-- Same lockdown as 0002 for the new table.
do $$
declare r text;
begin
  execute 'alter table operations enable row level security';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table operations from %I', r);
    end if;
  end loop;
end
$$;
