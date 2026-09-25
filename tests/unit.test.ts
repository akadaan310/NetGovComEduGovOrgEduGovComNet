import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authorize, effectiveScopes, type VerifiedCapability } from '../src/continuity/authority';
import { canonicalHash, canonicalJson } from '../src/continuity/canonical';
import { SeededRandom } from '../src/continuity/env';
import { newCapability, newResourceId, parseCapabilityToken, secretMatches } from '../src/continuity/ids';
import type { ResourceRow } from '../src/continuity/records';
import { bootstrapText } from '../src/protocol/bootstrap';
import { ResourceIdSchema } from '../src/protocol/constants';
import { OPERATIONS, OPERATIONS_BY_NAME } from '../src/protocol/operations';
import { esc } from '../src/transport/html';

const resource = (visibility: 'unlisted' | 'restricted' = 'unlisted') => ({ id: 'R1', visibility, lifecycle: 'active' }) as ResourceRow;
const cap = (scopes: string[], kind: 'owner' | 'delegation' = 'delegation'): VerifiedCapability => ({
  id: 'cap_0000000000',
  resource_id: 'R1',
  kind,
  session_id: 's',
  agent_id: null,
  scopes: scopes as never,
  expires_at: null,
});

describe('authority (pure)', () => {
  const op = (n: string) => OPERATIONS_BY_NAME[n];
  it('distinguishes read, write, ownership', () => {
    expect(authorize(op('inspect'), resource(), null).ok).toBe(true);
    expect(authorize(op('append'), resource(), null).ok).toBe(false);
    expect(authorize(op('append'), resource(), cap(['read'])).ok).toBe(false);
    expect(authorize(op('append'), resource(), cap(['append'])).ok).toBe(true);
    expect(authorize(op('delegate'), resource(), cap(['append', 'annotate', 'checkpoint', 'supersede', 'handoff'])).ok).toBe(false);
    expect(authorize(op('delegate'), resource(), cap(['owner'], 'owner')).ok).toBe(true);
    expect(authorize(op('propose'), resource(), null).ok).toBe(true);
    expect(authorize(op('propose'), resource('restricted'), null).ok).toBe(false);
    expect(authorize(op('inspect'), resource('restricted'), cap(['read'])).ok).toBe(true);
  });
  it('owner scope expands; read is implied', () => {
    expect(effectiveScopes(cap(['owner'], 'owner'))).toContain('handoff');
    expect(effectiveScopes(cap(['append']))).toEqual(['read', 'append']);
    expect(effectiveScopes(null)).toEqual([]);
  });
});

describe('ids and secrets', () => {
  it('are deterministic under a seed and well-formed', () => {
    const a = new SeededRandom(7);
    const b = new SeededRandom(7);
    expect(newResourceId(a)).toBe(newResourceId(b));
    const id = newResourceId(new SeededRandom(1));
    expect(ResourceIdSchema.safeParse(id).success).toBe(true);
    const c = newCapability(new SeededRandom(3));
    expect(parseCapabilityToken(c.token)).toEqual({ id: c.id, secret: c.secret });
    expect(secretMatches(c.secret, c.secretHash)).toBe(true);
    expect(secretMatches(c.secret.replace(/.$/, 'Z') === c.secret ? c.secret.replace(/.$/, 'Y') : c.secret.replace(/.$/, 'Z'), c.secretHash)).toBe(false);
    expect(c.secretHash).not.toContain(c.secret);
  });
});

describe('canonical JSON', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 2 } })).toBe('{"a":{"c":2,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1, u: undefined })).toBe(canonicalHash({ a: 1 }));
  });
});

describe('html escaping', () => {
  it('escapes all markup-significant characters', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('documentation stays in sync with the registry', () => {
  const protocolMd = readFileSync('PROTOCOL.md', 'utf8');
  it('PROTOCOL.md documents every operation', () => {
    for (const o of OPERATIONS) expect(protocolMd, `missing "#### ${o.name}"`).toContain(`#### ${o.name}\n`);
  });
  it('PROTOCOL.md contains the canonical bootstrap text verbatim', () => {
    expect(protocolMd).toContain(bootstrapText());
  });
  it('every mutation has a payload schema and complete semantics', () => {
    for (const o of OPERATIONS) {
      expect(o.purpose && o.authority_text && o.input && o.output && o.side_effects && o.provenance, o.name).toBeTruthy();
      expect(o.failures.length, o.name).toBeGreaterThan(0);
      if (o.mutation) expect(o.payload, o.name).toBeDefined();
    }
  });
});
