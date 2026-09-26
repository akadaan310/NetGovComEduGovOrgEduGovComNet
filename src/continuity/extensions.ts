/**
 * The extension interpreter — the ONLY implementation of every extension
 * operation. It never evaluates code: it substitutes validated input values
 * into the definition's effect templates, validates each resulting payload
 * with the core operation's own schema, authorizes each effect with the core
 * operation's own requirement, and runs the core handler. All effects run in
 * the engine's single transaction: all or nothing.
 */
import { OPERATIONS_BY_NAME } from '../protocol/operations';
import { EFFECT_OPERATIONS, type ExtensionDefinition, type Template } from '../protocol/extensions';
import { AcspError, fail } from '../protocol/errors';
import { authorize, describeRequirement } from './authority';
import type { OpContext } from './engine';
import { HANDLERS } from './handlers';
import { validatePayload } from './validate';

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * One pass over the TEMPLATE (trusted, from the registry). Values substituted
 * from input or earlier results are inserted as data and never re-scanned, so
 * input shaped like `{ "$input": … }` is just an object.
 */
export function resolveTemplate(t: Template, input: Record<string, unknown>, steps: { result: unknown }[]): unknown {
  if (Array.isArray(t)) return t.map((x) => resolveTemplate(x, input, steps));
  if (!isPlainObject(t)) return t;
  const keys = Object.keys(t);
  if (keys.length === 1 && keys[0] === '$input') return input[String(t.$input)];
  if (keys.length === 2 && '$step' in t && 'path' in t) {
    let v: unknown = steps[Number(t.$step)]?.result;
    for (const k of String(t.path).split('.')) v = isPlainObject(v) ? v[k] : undefined;
    return v;
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, resolveTemplate(v, input, steps)]));
}

/** The authority an extension needs: every effect's core requirement (reported, e.g. for discovery). */
export function extensionAuthority(ext: ExtensionDefinition): string[] {
  return [...new Set(ext.effects.map((e) => describeRequirement(OPERATIONS_BY_NAME[e.operation].authority)))];
}

export async function runExtension(ctx: OpContext, ext: ExtensionDefinition, input: Record<string, unknown>) {
  if (!ctx.cap) fail('authentication_required', `${ext.name} requires a capability satisfying: ${extensionAuthority(ext).join(' AND ')}.`);
  if (!(ctx.resource.enabled_extensions ?? []).includes(ext.name)) {
    fail('extension_not_enabled', `${ext.name} is not enabled on resource ${ctx.resource.id}. The owner enables extensions with update { enabled_extensions }.`);
  }
  // Authorize every effect BEFORE any effect runs.
  for (const e of ext.effects) {
    if (!(EFFECT_OPERATIONS as readonly string[]).includes(e.operation)) {
      throw new AcspError('internal_error', `${ext.name} declares a disallowed effect "${e.operation}".`);
    }
    const d = authorize(OPERATIONS_BY_NAME[e.operation], ctx.resource, ctx.cap);
    if (!d.ok) {
      fail('insufficient_authority', `${ext.name} needs ${extensionAuthority(ext).join(' AND ')}; effect "${e.operation}" is not authorized: ${d.error.message}`, {
        required: extensionAuthority(ext),
        failed_effect: e.operation,
      });
    }
  }
  ctx.extension = { name: ext.name, version: ext.version };
  const steps: { operation: string; result: Record<string, unknown> }[] = [];
  for (const e of ext.effects) {
    const payload = validatePayload(OPERATIONS_BY_NAME[e.operation], resolveTemplate(e.payload, input, steps));
    const handler = HANDLERS[e.operation] as (c: OpContext, p: never) => Promise<Record<string, unknown>>;
    steps.push({ operation: e.operation, result: await handler(ctx, payload as never) });
  }
  ctx.extension = null;
  return { extension: { name: ext.name, version: ext.version, status: ext.status }, steps };
}
