-- ACSP/0.1 initial schema.
--
-- The `events` table is the history. Every other table is a projection that
-- is updated in the same transaction as the event that changed it.

create table resources (
  id                   text primary key,
  protocol             text not null,
  title                text not null,
  description          text not null default '',
  focus                text not null default '',
  lifecycle            text not null check (lifecycle in ('active', 'closed')),
  visibility           text not null check (visibility in ('unlisted', 'restricted')),
  accepts_proposals    boolean not null default true,
  owner_session_id     text not null,
  owner_agent_id       text,
  owner_human          text,
  version              integer not null check (version >= 1),
  -- Counters used to allocate sequential, human-readable record ids.
  checkpoint_count     integer not null default 0,
  tok_count            integer not null default 0,
  annotation_count     integer not null default 0,
  handoff_count        integer not null default 0,
  proposal_count       integer not null default 0,
  parent_id            text references resources (id),
  parent_version       integer,
  parent_checkpoint    integer,
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  closed_at            timestamptz
);
create index resources_parent_idx on resources (parent_id);

create table events (
  resource_id          text not null references resources (id),
  version              integer not null,
  parent_version       integer not null,
  operation            text not null,
  actor_session_id     text not null,
  actor_agent_id       text,
  actor_kind           text not null,
  identity_assurance   text not null check (identity_assurance in ('capability', 'asserted')),
  capability_id        text,
  on_behalf_of         jsonb,
  proposal_id          text,
  occurred_at          timestamptz not null,
  summary              text not null,
  data                 jsonb not null,
  request_hash         text,
  idempotency_key      text,
  primary key (resource_id, version),
  check (parent_version = version - 1)
);

create table toks (
  resource_id              text not null references resources (id),
  id                       text not null,
  type                     text not null,
  title                    text not null,
  summary                  text not null default '',
  content                  text not null default '',
  stated_confidence        text not null default 'unclassified',
  status                   text not null default 'active' check (status in ('active', 'superseded')),
  supersedes               text,
  superseded_by            text,
  supersession_reason      text,
  refs                     jsonb not null default '[]',
  author_session_id        text not null,
  author_agent_id          text,
  author_kind              text not null,
  author_assurance         text not null,
  recorded_by_session_id   text not null,
  proposal_id              text,
  version                  integer not null,
  after_checkpoint         integer not null,
  created_at               timestamptz not null,
  responsible_session_id   text,
  origin                   jsonb,
  primary key (resource_id, id)
);

create table annotations (
  resource_id          text not null references resources (id),
  id                   text not null,
  tok_id               text not null,
  kind                 text not null,
  content              text not null,
  evidence             jsonb,
  author_session_id    text not null,
  author_agent_id      text,
  author_kind          text not null,
  author_assurance     text not null,
  recorded_by_session_id text not null,
  proposal_id          text,
  version              integer not null,
  created_at           timestamptz not null,
  primary key (resource_id, id),
  foreign key (resource_id, tok_id) references toks (resource_id, id)
);

create table checkpoints (
  resource_id          text not null references resources (id),
  number               integer not null,
  version              integer not null,
  label                text not null,
  note                 text not null default '',
  snapshot             jsonb not null,
  snapshot_sha256      text not null,
  created_by_session_id text not null,
  created_at           timestamptz not null,
  primary key (resource_id, number)
);

create table capabilities (
  id                   text primary key,
  resource_id          text not null references resources (id),
  secret_hash          text not null,
  kind                 text not null check (kind in ('owner', 'delegation')),
  session_id           text not null,
  agent_id             text,
  scopes               text[] not null,
  label                text not null default '',
  delegated_by_session_id text,
  created_version      integer not null,
  created_at           timestamptz not null,
  expires_at           timestamptz,
  revoked_at           timestamptz,
  revoked_version      integer
);
create index capabilities_resource_idx on capabilities (resource_id);

create table handoffs (
  resource_id          text not null references resources (id),
  id                   text not null,
  tok_id               text not null,
  from_session_id      text not null,
  to_session_id        text not null,
  to_agent_id          text,
  note                 text not null default '',
  status               text not null check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_version      integer not null,
  resolved_version     integer,
  resolution_note      text,
  created_at           timestamptz not null,
  primary key (resource_id, id)
);

create table proposals (
  resource_id          text not null references resources (id),
  id                   text not null,
  operation            text not null,
  payload              jsonb not null,
  rationale            text not null default '',
  proposer_session_id  text not null,
  proposer_agent_id    text,
  proposer_kind        text not null,
  proposer_assurance   text not null,
  status               text not null check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_version      integer not null,
  resolved_version     integer,
  resolution_note      text,
  result               jsonb,
  created_at           timestamptz not null,
  primary key (resource_id, id)
);

create table idempotency (
  scope                text not null,
  key                  text not null,
  request_hash         text not null,
  status_code          integer not null,
  response             jsonb not null,
  created_at           timestamptz not null,
  primary key (scope, key)
);

create table rate_limits (
  bucket               text not null,
  window_start         timestamptz not null,
  count                integer not null,
  primary key (bucket, window_start)
);

-- History is append-only: nothing may update or delete events or checkpoints.
create function acsp_forbid_history_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'ACSP: % is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'P0001';
end;
$$;

create trigger events_append_only
  before update or delete on events
  for each row execute function acsp_forbid_history_mutation();

create trigger checkpoints_append_only
  before update or delete on checkpoints
  for each row execute function acsp_forbid_history_mutation();
