/** GET /protocol — the machine-readable protocol, generated from the registry. */
import { ANNOTATION_KINDS, CONFIDENCE_LEVELS, TOK_TYPE_MEANINGS, TOK_TYPES, KNOWLEDGE_SEMANTICS } from '../research/tok';
import { bootstrapDocument, bootstrapText, NOTICE } from './bootstrap';
import {
  DELEGABLE_SCOPES,
  EXTENSIONS,
  INVARIANTS,
  RESOURCE_KINDS,
  PROTOCOL_NAME,
  PROTOCOL_TITLE,
  PROTOCOL_VERSION,
  RESOURCE_LIMITS,
  SCOPE_MEANINGS,
  VISIBILITY_MEANINGS,
} from './constants';
import { z } from 'zod';
import { ANNOUNCEMENT_KINDS, OBSERVATION_VOCABULARY } from '../research/phenotype';
import { SCROLL_LIMITS, ScrollContentSchema } from '../scrolls/scroll';
import { OPERATIONS, payloadJsonSchema } from './operations';
import { ERROR_STATUS } from './errors';
import { identityBootstrapDocument, identityBootstrapText, INTENT_STATES } from './program001';

export function protocolDocument(base: string) {
  const u = (p: string) => new URL(p, base).toString();
  return {
    protocol: { name: PROTOCOL_NAME, version: PROTOCOL_VERSION, title: PROTOCOL_TITLE, spec: u('/protocol'), spec_json: u('/protocol.json') },
    type: 'protocol',
    notice: NOTICE,
    invariants: [...INVARIANTS],
    extensions: [...EXTENSIONS],
    resource_kinds: [...RESOURCE_KINDS],
    summary:
      'ACSP is an HTTPS continuity substrate. A continuity resource at /r/{id} holds explicitly published research state (TOKs) ' +
      'with provenance. GET is always safe. Mutations are operations POSTed as a JSON envelope, authorised by capabilities.',
    concepts: {
      ownership: 'Exactly one owner session per resource; accountable; alone may update, delegate, revoke, resolve proposals, close.',
      access: VISIBILITY_MEANINGS,
      authority: 'Scopes carried by a capability (bearer token bound to one resource and one session).',
      delegation: 'The owner granting a named session scoped, expiring authority. Delegations cannot re-delegate.',
      task_responsibility: 'Per task TOK. Moves only by handoff (offer) + acknowledge (acceptance by the addressed session).',
      identity_assurance: {
        capability: 'The request presented a valid capability bound to the session_id.',
        asserted: 'No capability; the session_id is a claim. agent_id is always a claim.',
      },
      version: 'Increases by exactly 1 per event. A new resource is at version 1.',
      checkpoint: 'A numbered, hashed snapshot at one version. Checkpoint 0 is created with the resource. Distinct from version.',
      operation_intent: 'A described operation someone wants performed: prepared (GET ?action=prepare_<op>, never stored) or proposed (propose, stored).',
    },
    scopes: SCOPE_MEANINGS,
    delegable_scopes: [...DELEGABLE_SCOPES],
    knowledge: {
      semantics: KNOWLEDGE_SEMANTICS,
      tok_types: TOK_TYPE_MEANINGS,
      tok_type_list: [...TOK_TYPES],
      stated_confidence: [...CONFIDENCE_LEVELS],
      statuses: ['active', 'superseded'],
      annotation_kinds: [...ANNOTATION_KINDS],
    },
    envelope: {
      method: 'POST',
      endpoint: '/r/{id}/operations (create: POST /r)',
      content_type: 'application/json (or an HTML form with fields request=<envelope JSON> and capability=<token>)',
      authentication: 'Authorization: Bearer <capability> or the envelope field "capability".',
      fields: {
        protocol: `Must be "${PROTOCOL_VERSION}".`,
        operation: 'A mutating operation name.',
        actor: '{ session_id, agent_id?, kind: agent|human|system }. With a capability, session_id must match it (or be omitted).',
        expected_version: 'The version you last inspected. Required for update, supersede, resolve_proposal, close.',
        idempotency_key: 'Required. 8-128 chars [A-Za-z0-9._:-]. Same key + same request = replay of the original response.',
        payload: 'Operation-specific; see operations[].payload_schema.',
        create_key: 'create only, when the operator requires it.',
      },
    },
    reading: {
      formats: 'Every GET is HTML by default; JSON via a .json suffix, ?format=json, or Accept: application/json.',
      credential: 'Optional ?cap=<capability> (capability URL — a secret) or Authorization: Bearer, to see your authority or read restricted resources.',
      endpoints: {
        '/r/{id}': 'inspect — canonical resource document',
        '/r/{id}?action=status': 'status',
        '/r/{id}?action=prepare_{op}': 'operation intent document + form (no side effects)',
        '/r/{id}/operations': 'operations and whether your credential permits each',
        '/r/{id}/events?after=N&limit=M': 'event history',
        '/r/{id}/events/{version}': 'one event',
        '/r/{id}/knowledge/{tokId}': 'one TOK',
        '/r/{id}/checkpoints': 'checkpoint list',
        '/r/{id}/checkpoints/{n}': 'one checkpoint with snapshot',
        '/r/{id}/diff?from=V&to=W | ?since_checkpoint=N': 'diff',
        '/r/{id}/explorer': 'protocol explorer (HTML, for developers)',
        '/substrates': 'program-001: substrate registry with every manifest',
        '/substrates/{substrate_id}': 'program-001: one substrate manifest (operation contracts)',
        '/r/{id}/identity': 'program-001: agent identity and its separate dimensions',
        '/r/{id}/substrates': 'program-001: substrates available to this identity, and its current one',
        '/r/{id}/scrolls[/{scroll_id}[?version=n]]': 'program-001: Scrolls and their versions',
        '/r/{id}/aliases[/{name}]': 'program-001: aliases and their resolution',
        '/r/{id}/executions[/{execution_id}]': 'program-001: execution history',
        '/r/{id}/transitions': 'program-001: transition-history export for independent instruments',
      },
    },
    program_001: {
      question:
        'What computational phenomena emerge when persistent identity and state continuity are decoupled from the transient model substrate that performs each transition?',
      concepts: {
        agent_identity:
          'A continuity resource of kind "agent_identity". Its id is the agent_id. It persists across sessions, models and substrates. Identity is self-asserted and capability-bound, not cryptographic.',
        human_principal: 'The owner: authorizes the identity, delegates and revokes capabilities, releases embodiments. The principal is not the agent and cannot embody it.',
        embodiment: 'A session attached to the identity (embody → release), with a self-declared model and application. Only the embodied session acts AS the identity.',
        computational_substrate: 'Where an operation executes. Discoverable manifests with operation contracts (GET /substrates). Not a model, not an identity.',
        scroll: 'A persisted, versioned, immutable computational artifact: inputs, symbols, and steps that are substrate operations or calls to earlier Scroll versions.',
        alias: 'A reusable name bound to an explicit Scroll version; rebinding is recorded and history is kept.',
        execution: 'An append-only record of one run of one Scroll version: identity, session, embodiment, model, substrates, inputs, step sequence, outputs, status.',
        checkpoint_recovery:
          'An agent identity\'s checkpoint snapshot adds its identity, embodiments, Scroll versions with content, aliases with history, executions, authority (no secrets) and substrate context.',
        intent_states: INTENT_STATES,
      },
      scroll_schema: z.toJSONSchema(ScrollContentSchema, { io: 'input', unrepresentable: 'any' }),
      scroll_limits: SCROLL_LIMITS,
      announcement_kinds: [...ANNOUNCEMENT_KINDS],
      observation_vocabulary: OBSERVATION_VOCABULARY,
      identity_bootstrap: identityBootstrapDocument(),
      identity_bootstrap_text: identityBootstrapText(),
      substrates: u('/substrates'),
    },
    operations: OPERATIONS.map((o) => ({
      name: o.name,
      family: o.family,
      mutation: o.mutation,
      purpose: o.purpose,
      invocation: o.invocation,
      required_authority: o.authority,
      authority_text: o.authority_text,
      requires_expected_version: o.requires_expected_version,
      proposable: o.proposable,
      allowed_when_closed: o.allowed_when_closed,
      input: o.input,
      output: o.output,
      side_effects: o.side_effects,
      provenance: o.provenance,
      failures: o.failures,
      payload_schema: payloadJsonSchema(o),
      doc_href: u(`/protocol#op-${o.name}`),
    })),
    errors: ERROR_STATUS,
    limits: RESOURCE_LIMITS,
    bootstrap: bootstrapDocument(),
    bootstrap_text: bootstrapText(),
    links: { home: u('/'), new_resource: u('/new'), discovery: u('/.well-known/acsp'), substrates: u('/substrates') },
  };
}
export type ProtocolDocument = ReturnType<typeof protocolDocument>;
