/**
 * The substrate registry: every computational substrate this ACSP service
 * knows, with a machine-readable manifest. Clients discover capability from
 * the manifest (GET /substrates), not from prior knowledge.
 */
import { canonicalHash } from '../continuity/canonical';
import { deterministicCalculator } from './calculator';
import { exactRationalCalculator } from './rational';
import type { OperationContract, Substrate, SubstrateManifest } from './types';

/**
 * Declared so the abstraction is visible: a model-backed session (ChatGPT,
 * Claude, Gemini, a local model) is a kind of substrate. Program 001
 * implements NO adapter, and ACSP never calls a model or a paid API.
 */
const modelSession: Substrate = {
  manifest: {
    substrate_id: 'model-session',
    kind: 'model-session',
    provider: 'external',
    version: '0',
    status: 'unavailable',
    execution_mode: 'external',
    description:
      'Declared abstraction for a model-backed session. No adapter is implemented in Program 001: ' +
      'a model embodies an identity from outside ACSP (see "embody"); ACSP does not execute models.',
    value_domain: 'none',
    capabilities: [],
    operations: [],
    surface: { protocol: 'acsp-local', purl_manifest: null },
    provenance: { implementation: 'src/substrates/registry.ts (declaration only)', introduced_by: 'ACSP Program 001' },
  },
  apply: () => ({ ok: false, error: { code: 'substrate_unavailable', message: 'model-session has no adapter.' } }),
};

export const SUBSTRATES: Substrate[] = [deterministicCalculator, exactRationalCalculator, modelSession];
const BY_ID = new Map(SUBSTRATES.map((s) => [s.manifest.substrate_id, s]));

export const SUBSTRATE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function getSubstrate(id: string): Substrate | undefined {
  return BY_ID.get(id);
}

/** Hash of the manifest content: execution records cite it, so a changed manifest is detectable. */
export function manifestHash(m: SubstrateManifest): string {
  return canonicalHash(m);
}

export function substrateRef(s: Substrate) {
  return { substrate_id: s.manifest.substrate_id, version: s.manifest.version, manifest_sha256: manifestHash(s.manifest) };
}
export type SubstrateRef = ReturnType<typeof substrateRef>;

/** Contract for `op`, taken from any substrate that offers it (all share names and arity by construction). */
export function findContract(op: string): OperationContract | undefined {
  for (const s of SUBSTRATES) {
    if (s.manifest.status !== 'available') continue;
    const c = s.manifest.operations.find((o) => o.name === op);
    if (c) return c;
  }
  return undefined;
}

export const ALL_OPERATION_NAMES = Array.from(new Set(SUBSTRATES.flatMap((s) => s.manifest.capabilities))).sort();
