-- Program 001: agent identity + computational substrate + Scroll.
--
-- An agent identity is a continuity resource of kind 'agent_identity'. It
-- reuses resources/events/capabilities/checkpoints/idempotency unchanged.
-- New projections:
--   embodiments     which session (and declared model/application) embodies the identity
--   scrolls         immutable Scroll versions            (append-only)
--   alias_bindings  every binding of an alias, in order  (append-only)
--   executions      every execution / discovery trial    (append-only)
-- The event log remains the history; these tables are written in the same
-- transaction as the event that changed them.

alter table resources
  add column kind text not null default 'continuity_resource'
    check (kind in ('continuity_resource', 'agent_identity')),
  add column also_known_as jsonb not null default '[]',
  add column current_substrate_id text,
  add column scroll_count integer not null default 0,
  add column execution_count integer not null default 0,
  add column embodiment_count integer not null default 0;

create table embodiments (
  resource_id            text not null references resources (id),
  id                     text not null,
  session_id             text not null,
  agent_label            text,
  capability_id          text,
  model                  jsonb,
  application            jsonb,
  note                   text not null default '',
  status                 text not null check (status in ('active', 'released')),
  attached_version       integer not null,
  released_version       integer,
  release_reason         text,
  released_by_session_id text,
  created_at             timestamptz not null,
  released_at            timestamptz,
  primary key (resource_id, id)
);
-- At most one active embodiment per identity.
create unique index embodiments_one_active on embodiments (resource_id) where status = 'active';

create table scrolls (
  resource_id            text not null references resources (id),
  scroll_id              text not null,
  version                integer not null check (version >= 1),
  parent_version         integer,
  content                jsonb not null,
  content_sha256         text not null,
  author_session_id      text not null,
  author_agent_id        text,
  author_kind            text not null,
  author_assurance       text not null,
  recorded_by_session_id text not null,
  embodiment_id          text,
  proposal_id            text,
  event_version          integer not null,
  after_checkpoint       integer not null,
  created_at             timestamptz not null,
  primary key (resource_id, scroll_id, version),
  check ((version = 1 and parent_version is null) or parent_version = version - 1)
);

create table alias_bindings (
  resource_id            text not null references resources (id),
  name                   text not null,
  binding                integer not null check (binding >= 1),
  scroll_id              text not null,
  scroll_version         integer not null,
  reason                 text not null default '',
  author_session_id      text not null,
  author_assurance       text not null,
  embodiment_id          text,
  proposal_id            text,
  event_version          integer not null,
  created_at             timestamptz not null,
  primary key (resource_id, name, binding),
  foreign key (resource_id, scroll_id, scroll_version) references scrolls (resource_id, scroll_id, version)
);

create table executions (
  resource_id            text not null references resources (id),
  id                     text not null,
  number                 integer not null,
  kind                   text not null check (kind in ('scroll', 'trial')),
  scroll_id              text,
  scroll_version         integer,
  scroll_sha256          text,
  via_alias              jsonb,
  inputs                 jsonb not null,
  steps                  jsonb not null,
  outputs                jsonb,
  status                 text not null check (status in ('completed', 'failed')),
  error                  jsonb,
  default_substrate      jsonb,
  session_id             text not null,
  agent_label            text,
  identity_assurance     text not null,
  embodiment_id          text,
  model                  jsonb,
  application            jsonb,
  proposal_id            text,
  on_behalf_of           jsonb,
  parent_checkpoint      integer not null,
  event_version          integer not null,
  started_at             timestamptz not null,
  completed_at           timestamptz not null,
  primary key (resource_id, id),
  unique (resource_id, number)
);

-- Committed Scroll versions, alias bindings and executions are immutable.
create trigger scrolls_append_only
  before update or delete on scrolls
  for each row execute function acsp_forbid_history_mutation();
create trigger alias_bindings_append_only
  before update or delete on alias_bindings
  for each row execute function acsp_forbid_history_mutation();
create trigger executions_append_only
  before update or delete on executions
  for each row execute function acsp_forbid_history_mutation();

-- Same lockdown as 0002 for hosted-database API roles.
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['embodiments', 'scrolls', 'alias_bindings', 'executions'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array['embodiments', 'scrolls', 'alias_bindings', 'executions'] loop
        execute format('revoke all on table %I from %I', t, r);
      end loop;
    end if;
  end loop;
end
$$;
