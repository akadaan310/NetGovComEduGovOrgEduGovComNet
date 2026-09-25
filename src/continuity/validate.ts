import type { OperationSpec } from '../protocol/operations';
import { fail } from '../protocol/errors';

export const formatIssue = (i: { path: PropertyKey[]; message: string }) => ({
  path: i.path.map(String).join('.'),
  message: i.message,
});

/** Validate (and normalise, applying defaults) an operation payload against its registry schema. */
export function validatePayload(spec: OperationSpec, payload: unknown): Record<string, unknown> {
  const parsed = spec.payload!.safeParse(payload ?? {});
  if (!parsed.success) {
    fail('invalid_payload', `The payload for "${spec.name}" is invalid.`, { issues: parsed.error.issues.map(formatIssue) });
  }
  return parsed.data as Record<string, unknown>;
}
