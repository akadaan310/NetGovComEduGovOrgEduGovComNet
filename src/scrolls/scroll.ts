/**
 * COMPUTATION LAYER — Scrolls (Program 001).
 *
 * A Scroll is a persisted, versioned computational artifact created by an
 * agent identity: named inputs, constant symbols, and an ordered sequence of
 * steps, each either a substrate operation or a call to an earlier Scroll
 * version (composition). It is data, not code: nothing is evaluated except
 * the closed operation sets of registered substrates.
 *
 *   Scroll definition  — this content, immutable once committed (scrolls table)
 *   Scroll execution   — one run of one version on given inputs (executions table)
 *   Scroll result      — the outputs recorded inside that execution
 *
 * Pure: no HTTP, no database, no authority. The continuity layer supplies a
 * lookup of existing Scroll versions and resolves substrates.
 */
import { z } from 'zod';
import { canonicalHash, canonicalJson } from '../continuity/canonical';
import { RATIONAL_RE } from '../substrates/rational';
import { findContract, getSubstrate, SUBSTRATE_ID_RE, substrateRef, type SubstrateRef } from '../substrates/registry';
import type { Substrate, Value } from '../substrates/types';

export const SCROLL_LIMITS = {
  contentBytes: 16 * 1024,
  steps: 64,
  inputs: 16,
  symbols: 16,
  /** Primitive substrate steps per execution, after expanding composed Scrolls. */
  executedSteps: 256,
  compositionDepth: 8,
  trialsPerDiscovery: 16,
} as const;

export const NameSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,31}$/, 'must match [a-z_][a-z0-9_]{0,31}');
export const ScrollIdSchema = z.string().regex(/^SCR-\d{3,}$/, 'must look like SCR-001');
export const AliasNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'must match [a-z][a-z0-9_-]{0,63}');
export const SubstrateIdSchema = z.string().regex(SUBSTRATE_ID_RE, 'must be a substrate id such as deterministic-calculator');
export const ValueSchema = z.union([z.number(), z.string().regex(RATIONAL_RE, 'must be a number or a rational string "p/q"')]);

export const ScrollRefSchema = z.strictObject({ scroll_id: ScrollIdSchema, version: z.number().int().min(1) });
export type ScrollRef = z.output<typeof ScrollRefSchema>;
export const refString = (r: ScrollRef) => `${r.scroll_id}:v${r.version}`;

const ArgSchema = z.union([NameSchema, z.number()]);
const OperationStepSchema = z.strictObject({
  id: NameSchema.optional(),
  substrate: SubstrateIdSchema.optional(),
  operation: z.string().regex(/^[a-z_]{1,32}$/, 'must be an operation name'),
  arguments: z.array(ArgSchema).max(8),
});
const ScrollStepSchema = z.strictObject({
  id: NameSchema.optional(),
  scroll: ScrollRefSchema,
  arguments: z.array(ArgSchema).max(SCROLL_LIMITS.inputs),
});

export const ScrollContentSchema = z.strictObject({
  purpose: z.string().trim().min(1).max(500),
  description: z.string().trim().max(2_000).default(''),
  inputs: z
    .array(NameSchema)
    .max(SCROLL_LIMITS.inputs)
    .default([])
    .refine((a) => new Set(a).size === a.length, 'input names must be unique'),
  symbols: z
    .record(NameSchema, ValueSchema)
    .default({})
    .refine((s) => Object.keys(s).length <= SCROLL_LIMITS.symbols, `at most ${SCROLL_LIMITS.symbols} symbols`),
  operations: z.array(z.union([OperationStepSchema, ScrollStepSchema])).min(1).max(SCROLL_LIMITS.steps),
  output: NameSchema.optional(),
});
export type ScrollContentInput = z.output<typeof ScrollContentSchema>;

export type OperationStep = { id: string; substrate?: string; operation: string; arguments: (string | number)[] };
export type CallStep = { id: string; scroll: ScrollRef; arguments: (string | number)[] };
export type Step = OperationStep | CallStep;
export const isCall = (s: Step): s is CallStep => 'scroll' in s;

/** Normalised content: every step has an id, and `output` is set. This is what gets hashed and stored. */
export interface ScrollContent {
  purpose: string;
  description: string;
  inputs: string[];
  symbols: Record<string, Value>;
  operations: Step[];
  output: string;
}

export type ScrollLookup = (ref: ScrollRef) => ScrollContent | undefined;
export interface Issue {
  path: string;
  message: string;
}

/**
 * Normalise and statically validate a Scroll against the substrate registry
 * and the identity's existing Scroll versions. Returns issues instead of
 * throwing, so the same check serves operations and prepared intents.
 */
export function validateScroll(input: ScrollContentInput, lookup: ScrollLookup): { content: ScrollContent; issues: Issue[] } {
  const issues: Issue[] = [];
  const defined = new Set<string>();
  const define = (name: string, path: string) => {
    if (defined.has(name)) issues.push({ path, message: `"${name}" is already defined` });
    defined.add(name);
  };
  input.inputs.forEach((n, i) => define(n, `inputs.${i}`));
  Object.keys(input.symbols).forEach((n) => define(n, `symbols.${n}`));

  const operations: Step[] = input.operations.map((raw, i) => {
    const path = `operations.${i}`;
    const id = raw.id ?? `s${i + 1}`;
    raw.arguments.forEach((arg, j) => {
      if (typeof arg === 'string' && !defined.has(arg)) {
        issues.push({ path: `${path}.arguments.${j}`, message: `"${arg}" is not an input, symbol or earlier step` });
      }
    });
    let step: Step;
    if ('scroll' in raw) {
      const callee = lookup(raw.scroll);
      if (!callee) issues.push({ path: `${path}.scroll`, message: `${refString(raw.scroll)} does not exist in this identity` });
      else if (callee.inputs.length !== raw.arguments.length) {
        issues.push({ path: `${path}.arguments`, message: `${refString(raw.scroll)} takes ${callee.inputs.length} argument(s), got ${raw.arguments.length}` });
      }
      step = { id, scroll: raw.scroll, arguments: raw.arguments };
    } else {
      if (raw.substrate !== undefined) {
        const s = getSubstrate(raw.substrate);
        if (!s) issues.push({ path: `${path}.substrate`, message: `unknown substrate "${raw.substrate}"` });
        else if (s.manifest.status !== 'available') issues.push({ path: `${path}.substrate`, message: `substrate "${raw.substrate}" is ${s.manifest.status}` });
        else if (!s.manifest.capabilities.includes(raw.operation)) {
          issues.push({ path: `${path}.operation`, message: `substrate "${raw.substrate}" has no operation "${raw.operation}"` });
        }
      }
      const contract = findContract(raw.operation);
      if (!contract) issues.push({ path: `${path}.operation`, message: `no available substrate offers "${raw.operation}"` });
      else if (contract.arity !== raw.arguments.length) {
        issues.push({ path: `${path}.arguments`, message: `"${raw.operation}" takes ${contract.arity} argument(s), got ${raw.arguments.length}` });
      }
      step = { id, ...(raw.substrate !== undefined ? { substrate: raw.substrate } : {}), operation: raw.operation, arguments: raw.arguments };
    }
    define(id, `${path}.id`);
    return step;
  });

  const output = input.output ?? operations[operations.length - 1].id;
  if (!defined.has(output)) issues.push({ path: 'output', message: `"${output}" is not defined` });

  const content: ScrollContent = {
    purpose: input.purpose,
    description: input.description,
    inputs: input.inputs,
    symbols: input.symbols,
    operations,
    output,
  };
  const bytes = Buffer.byteLength(canonicalJson(content), 'utf8');
  if (bytes > SCROLL_LIMITS.contentBytes) {
    issues.push({ path: '', message: `the Scroll is ${bytes} bytes of canonical JSON; the limit is ${SCROLL_LIMITS.contentBytes}` });
  }
  return { content, issues };
}

export const contentHash = (c: ScrollContent) => canonicalHash(c);

/** What a Scroll depends on, derived from its content (not stored separately). */
export function dependencies(c: ScrollContent) {
  const ops = c.operations.filter((s): s is OperationStep => !isCall(s));
  const calls = c.operations.filter(isCall);
  return {
    scrolls: Array.from(new Set(calls.map((s) => refString(s.scroll)))),
    pinned_substrates: Array.from(new Set(ops.map((s) => s.substrate).filter((x): x is string => !!x))),
    operations: Array.from(new Set(ops.map((s) => s.operation))),
    composition: calls.length > 0,
    uses_default_substrate: ops.some((s) => s.substrate === undefined),
  };
}

/**
 * Substrates an execution will need, following composed Scrolls: the pinned
 * ones, and whether any step relies on the execution's default substrate.
 */
export function requiredSubstrates(c: ScrollContent, lookup: ScrollLookup, depth = 0): { pinned: Set<string>; needsDefault: boolean } {
  const out = { pinned: new Set<string>(), needsDefault: false };
  if (depth > SCROLL_LIMITS.compositionDepth) return out;
  for (const s of c.operations) {
    if (isCall(s)) {
      const callee = lookup(s.scroll);
      if (!callee) continue;
      const sub = requiredSubstrates(callee, lookup, depth + 1);
      sub.pinned.forEach((p) => out.pinned.add(p));
      out.needsDefault ||= sub.needsDefault;
    } else if (s.substrate) out.pinned.add(s.substrate);
    else out.needsDefault = true;
  }
  return out;
}

export interface StepRecord {
  path: string;
  substrate?: SubstrateRef;
  operation?: string;
  scroll?: string;
  arguments: Value[];
  result?: Value;
  error?: { code: string; message: string };
}

export type Evaluation =
  | { status: 'completed'; outputs: Record<string, Value>; steps: StepRecord[] }
  | { status: 'failed'; error: { code: string; message: string; at: string }; steps: StepRecord[] };

/**
 * Evaluate a Scroll on inputs. Deterministic: the same content, inputs and
 * substrates always give the same record. `defaultSubstrate` runs every step
 * that does not pin one. Request-level problems (missing inputs, unavailable
 * substrates) must be checked by the caller first; this reports only
 * computational outcomes.
 */
export function evaluate(c: ScrollContent, inputs: Record<string, Value>, lookup: ScrollLookup, defaultSubstrate: Substrate | null): Evaluation {
  const steps: StepRecord[] = [];
  const budget = { left: SCROLL_LIMITS.executedSteps };

  const run = (sc: ScrollContent, args: Record<string, Value>, prefix: string, depth: number): { ok: true; value: Value } | { ok: false; error: { code: string; message: string; at: string } } => {
    if (depth > SCROLL_LIMITS.compositionDepth) {
      return { ok: false, error: { code: 'composition_too_deep', message: `Composition deeper than ${SCROLL_LIMITS.compositionDepth}.`, at: prefix || 'root' } };
    }
    const env = new Map<string, Value>(Object.entries({ ...sc.symbols, ...args }));
    const val = (a: string | number) => (typeof a === 'number' ? a : env.get(a)!);
    for (const s of sc.operations) {
      const path = `${prefix}${s.id}`;
      const argv = s.arguments.map(val);
      if (isCall(s)) {
        const callee = lookup(s.scroll)!;
        const bound = Object.fromEntries(callee.inputs.map((n, i) => [n, argv[i]]));
        const r = run(callee, bound, `${path}/`, depth + 1);
        steps.push({ path, scroll: refString(s.scroll), arguments: argv, ...(r.ok ? { result: r.value } : { error: { code: r.error.code, message: r.error.message } }) });
        if (!r.ok) return r;
        env.set(s.id, r.value);
        continue;
      }
      if (budget.left-- <= 0) {
        return { ok: false, error: { code: 'step_budget_exceeded', message: `More than ${SCROLL_LIMITS.executedSteps} substrate steps.`, at: path } };
      }
      const sub = s.substrate ? getSubstrate(s.substrate)! : defaultSubstrate!;
      const r = sub.apply(s.operation, argv);
      steps.push({ path, substrate: substrateRef(sub), operation: s.operation, arguments: argv, ...(r.ok ? { result: r.value } : { error: r.error }) });
      if (!r.ok) return { ok: false, error: { ...r.error, at: path } };
      env.set(s.id, r.value);
    }
    return { ok: true, value: env.get(sc.output)! };
  };

  const r = run(c, inputs, '', 0);
  return r.ok ? { status: 'completed', outputs: { [c.output]: r.value }, steps } : { status: 'failed', error: r.error, steps };
}
