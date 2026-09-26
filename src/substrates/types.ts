/**
 * COMPUTATION LAYER — computational substrates (Program 001).
 *
 * A substrate is the computational environment through which an agent
 * identity performs an operation. It is NOT a model and NOT an identity.
 * Substrates here are pure: they compute a value from arguments and have no
 * side effects. The only state change is the execution record that the
 * continuity layer writes when an identity executes a Scroll.
 *
 * This module knows nothing about HTTP, versions, events or authority.
 */

/** A value flowing through a Scroll: a finite JSON number, or an exact rational "p/q" string. */
export type Value = number | string;

export type SubstrateStatus = 'available' | 'unavailable';

export interface OperationContract {
  name: string;
  description: string;
  /** Positional argument count. */
  arity: number;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  required_authority: string;
  side_effects: string;
  determinism: 'deterministic';
  failure_modes: string[];
}

export interface SubstrateManifest {
  substrate_id: string;
  kind: string;
  provider: string;
  version: string;
  status: SubstrateStatus;
  execution_mode: 'in-process-pure' | 'external';
  description: string;
  value_domain: string;
  /** Operation names, for quick discovery. The full contracts are in `operations`. */
  capabilities: string[];
  operations: OperationContract[];
  /**
   * Where the surface is addressed. Program 001 substrates are local to this
   * ACSP service. A PURL resource manifest could be referenced here later;
   * ACSP would still own continuity and authority.
   */
  surface: { protocol: 'acsp-local'; purl_manifest: string | null };
  provenance: { implementation: string; introduced_by: string };
}

export type ApplyResult = { ok: true; value: Value } | { ok: false; error: { code: string; message: string } };

export interface Substrate {
  manifest: SubstrateManifest;
  apply(operation: string, args: Value[]): ApplyResult;
}

export const failure = (code: string, message: string): ApplyResult => ({ ok: false, error: { code, message } });

/** Shared authority/side-effect text: substrate operations are only ever reached through `execute` or `discover_new_operation`. */
export const INVOKED_VIA =
  'Not invoked directly. An agent identity reaches it through the "execute" operation (scope "execute", as the embodied session) ' +
  'or "discover_new_operation" (trials).';
export const PURE = 'None. The computation is pure; the only state change is the execution record written by the calling operation.';
