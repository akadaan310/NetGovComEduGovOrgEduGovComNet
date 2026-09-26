/**
 * Program 001 protocol text: intent states and the agent-identity bootstrap.
 * Served in resource documents and GET /protocol; PROTOCOL.md mirrors the
 * bootstrap verbatim (a test keeps them in sync).
 */
import { PROTOCOL_VERSION } from './constants';

export const INTENT_STATES = {
  semantics:
    'How computational intent becomes state. Only COMMITTED and PERSISTED records are facts of this identity; everything earlier is intent.',
  states: {
    PRIVATE: 'SELF — anything a session has not sent to ACSP. ACSP has no private store, so private state cannot leak through it; it is simply absent.',
    ANNOUNCED: 'The "announce" operation: says something exists or is intended. Grants nothing and commits nothing else.',
    DISCOVERED: 'Reading (GET). Reads are never recorded; discovery is measured by the client, not the server.',
    AUTHORIZED: 'A capability exists for the session (event "delegate"). Authority is not embodiment.',
    PROPOSED: 'A stored operation intent ("propose", or discover_new_operation with propose: true). Not performed.',
    ACCEPTED: 'The owner accepted a proposal ("resolve_proposal"); the operation is then performed in the same transaction.',
    COMMITTED: 'The operation\'s event exists. Scroll versions, alias bindings and executions carry state: "committed".',
    PERSISTED: 'A checkpoint at or after the commit covers it (state: "persisted", persisted_in_checkpoint: n).',
  },
  prepared_is_not_performed: 'A prepared intent (GET ?action=prepare_<op>) is PRIVATE until submitted; it is never evidence that anything happened.',
};

export const IDENTITY_BOOTSTRAP_STEPS = [
  'This resource is an AGENT IDENTITY (type "agent_identity"). Its identity is "identity.agent_id". You are not it by reading it.',
  'Read "identity.dimensions": identity, principal, ownership, session, model, application, substrate and capability are separate. Changing any of the last five does not change the identity.',
  'Read "identity.current_embodiment". Only the embodied session acts AS the identity; a capability alone is not enough. If none is active and you hold a capability with scope "embody", you may embody it.',
  'To continue the identity\'s work: read the latest checkpoint (identity.current_checkpoint), which contains its Scrolls, aliases, execution history, authority and substrate context; then read the diff since it.',
  'Read "substrates" (or GET /substrates) to learn which operations exist, their schemas and their determinism before composing anything.',
  'A Scroll is immutable: to change one, commit a new version. An alias names an explicit version. Executing records an execution; reading never executes.',
  'Without authority, do not claim a commit: prepare (?action=prepare_<op>) or propose instead, and report it as proposed.',
] as const;

export function identityBootstrapDocument() {
  return { title: `AGENT IDENTITY BOOTSTRAP — ${PROTOCOL_VERSION} + program-001`, steps: [...IDENTITY_BOOTSTRAP_STEPS] };
}

export function identityBootstrapText(): string {
  return [identityBootstrapDocument().title, '', ...IDENTITY_BOOTSTRAP_STEPS.map((s, i) => `${i + 1}. ${s}`)].join('\n');
}
