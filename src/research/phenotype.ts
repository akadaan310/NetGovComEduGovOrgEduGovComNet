/**
 * RESEARCH LAYER — computational phenotype observation (Program 001).
 *
 * A fixed vocabulary of OBSERVABLE labels, derived deterministically from the
 * recorded event history of an agent identity. It is deliberately not a
 * personality model: no trait, disposition or dimension is predefined. Later
 * instruments (e.g. SubstrateIO) may compute recurring patterns from these
 * labels; naming those patterns comes after measuring them.
 *
 * "DNA"/"phenotype" are metaphors. Nothing here is a biological claim, and
 * nothing here observes a model's internal state — only protocol events.
 *
 * Pure: knows nothing about HTTP, databases or authority.
 */

export const ANNOUNCEMENT_KINDS = ['availability', 'intent', 'artifact', 'surface'] as const;

export const OBSERVATION_VOCABULARY = {
  IDENTITY_CREATED: 'An agent identity resource was created.',
  IDENTITY_RETIRED: 'An agent identity was closed.',
  EMBODIMENT_ATTACHED: 'A session attached itself to the identity as its embodiment (embody).',
  EMBODIMENT_RELEASED: 'An embodiment ended (release, or release on close).',
  SESSION_CHANGED: 'An embodiment began in a session different from the previous embodiment\'s session.',
  MODEL_CHANGED: 'An embodiment declared a model different from the previous embodiment\'s declared model (self-asserted).',
  RECOVERY: 'An embodiment began after an earlier embodiment of the same identity had ended: the identity was continued by another embodiment.',
  SUBSTRATE_SELECTED: 'A substrate became the identity\'s current substrate.',
  SUBSTRATE_ATTACHED: 'A substrate was attached where none was current.',
  SUBSTRATE_DETACHED: 'The current substrate stopped being current (detached or replaced).',
  SUBSTRATE_CHANGED: 'The current substrate was replaced by a different one.',
  ANNOUNCEMENT: 'The identity announced something; nothing was granted or committed by it.',
  SCROLL_CREATED: 'A new Scroll (version 1) was committed.',
  SCROLL_VERSIONED: 'A new version of an existing Scroll was committed.',
  OPERATION_SELECTED: 'A committed Scroll or tested candidate uses one or more substrate operations.',
  OPERATION_ORDERED: 'A committed Scroll or tested candidate orders two or more steps.',
  COMPOSITION: 'A committed Scroll or tested candidate calls an earlier Scroll version.',
  ALIAS_CREATED: 'A name was bound to a Scroll version for the first time.',
  ALIAS_REBOUND: 'An existing name was rebound to another Scroll version.',
  EXECUTION: 'A Scroll version was executed and the execution recorded.',
  EXECUTION_FAILED: 'A recorded execution ended in a computational failure.',
  ALIAS_RESOLVED: 'An execution reached its Scroll version through an alias.',
  REUSE: 'A Scroll version was executed that had been executed before.',
  OPERATION_REPEATED: 'A Scroll version was executed on inputs identical to an earlier execution of it.',
  RETRY: 'A Scroll version was executed after its previous execution had failed.',
  DISCOVERY_TRIAL: 'A candidate composition was tested (discover_new_operation).',
  PROPOSAL: 'An operation was proposed, not performed.',
  PROPOSAL_ACCEPTED: 'The owner accepted a proposal; the proposed operation was then performed.',
  PROPOSAL_REJECTED: 'The owner rejected a proposal.',
  DELEGATION: 'The owner granted a session a capability.',
  REVOCATION: 'The owner revoked a capability.',
  HANDOFF: 'Task responsibility was offered to another session.',
  CHECKPOINT: 'A hashed checkpoint was created.',
} as const;
export type Observation = keyof typeof OBSERVATION_VOCABULARY;

/** The subset of an event record the derivation reads. */
export interface ObservableEvent {
  version: number;
  operation: string;
  actor: { session_id: string };
  data: Record<string, unknown>;
}

type Rec = Record<string, unknown>;
const str = (v: unknown) => (v === undefined ? 'null' : JSON.stringify(v));

/**
 * Label each event. Deterministic and order-dependent: labels such as REUSE
 * or RECOVERY refer to what happened earlier in the same history.
 */
export function deriveObservations(events: ObservableEvent[], isAgentIdentity: boolean): Observation[][] {
  let lastEmbodiment: { session_id: string; model: unknown } | null = null;
  let embodimentEnded = false;
  const executed = new Map<string, { inputs: Set<string>; lastStatus: string }>();

  return events.map((e) => {
    const d = e.data as Rec;
    const out: Observation[] = [];
    switch (e.operation) {
      case 'create':
        if (isAgentIdentity) out.push('IDENTITY_CREATED');
        break;
      case 'close':
        if (isAgentIdentity) out.push('IDENTITY_RETIRED');
        if ((d.released_embodiments as unknown[] | undefined)?.length) {
          out.push('EMBODIMENT_RELEASED');
          embodimentEnded = true;
        }
        break;
      case 'embody': {
        out.push('EMBODIMENT_ATTACHED');
        if (lastEmbodiment) {
          if (lastEmbodiment.session_id !== d.session_id) out.push('SESSION_CHANGED');
          if (str(lastEmbodiment.model) !== str(d.model)) out.push('MODEL_CHANGED');
        }
        if (embodimentEnded) out.push('RECOVERY');
        lastEmbodiment = { session_id: String(d.session_id), model: d.model ?? null };
        embodimentEnded = false;
        break;
      }
      case 'release':
        out.push('EMBODIMENT_RELEASED');
        embodimentEnded = true;
        break;
      case 'set_substrate':
        if (d.to) out.push('SUBSTRATE_SELECTED');
        if (d.change === 'attached') out.push('SUBSTRATE_ATTACHED');
        if (d.change === 'changed') out.push('SUBSTRATE_DETACHED', 'SUBSTRATE_ATTACHED', 'SUBSTRATE_CHANGED');
        if (d.change === 'detached') out.push('SUBSTRATE_DETACHED');
        break;
      case 'announce':
        out.push('ANNOUNCEMENT');
        break;
      case 'create_scroll':
      case 'version_scroll':
        out.push(e.operation === 'create_scroll' ? 'SCROLL_CREATED' : 'SCROLL_VERSIONED');
        shape(d, out);
        break;
      case 'set_alias':
        out.push(Number(d.binding) === 1 ? 'ALIAS_CREATED' : 'ALIAS_REBOUND');
        break;
      case 'execute': {
        out.push('EXECUTION');
        if (d.status === 'failed') out.push('EXECUTION_FAILED');
        if (d.via_alias) out.push('ALIAS_RESOLVED');
        const s = d.scroll as { ref?: string } | undefined;
        const key = s?.ref ?? '';
        const prior = executed.get(key);
        if (prior) {
          out.push('REUSE');
          if (prior.inputs.has(String(d.inputs_sha256))) out.push('OPERATION_REPEATED');
          if (prior.lastStatus === 'failed') out.push('RETRY');
        }
        const entry = prior ?? { inputs: new Set<string>(), lastStatus: '' };
        entry.inputs.add(String(d.inputs_sha256));
        entry.lastStatus = String(d.status);
        executed.set(key, entry);
        break;
      }
      case 'discover_new_operation':
        out.push('DISCOVERY_TRIAL');
        shape(d, out);
        break;
      case 'propose':
        out.push('PROPOSAL');
        break;
      case 'resolve_proposal':
        out.push(d.decision === 'accept' ? 'PROPOSAL_ACCEPTED' : 'PROPOSAL_REJECTED');
        break;
      case 'delegate':
        out.push('DELEGATION');
        break;
      case 'revoke':
        out.push('REVOCATION');
        break;
      case 'handoff':
        out.push('HANDOFF');
        break;
      case 'checkpoint':
        out.push('CHECKPOINT');
        break;
    }
    return out;
  });
}

function shape(d: Rec, out: Observation[]) {
  if ((d.operations as unknown[] | undefined)?.length) out.push('OPERATION_SELECTED');
  if (Number(d.step_count) >= 2) out.push('OPERATION_ORDERED');
  if (d.composition) out.push('COMPOSITION');
}
