import { sha256Hex } from './ids';

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, `undefined`
 * members dropped. Used for request hashes and checkpoint snapshot hashes, so
 * any party can recompute them.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export const canonicalHash = (value: unknown) => `sha256:${sha256Hex(canonicalJson(value))}`;
