import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authorize, type VerifiedCapability } from '../src/continuity/authority';
import type { ResourceRow } from '../src/continuity/records';
import { OPERATIONS, OPERATIONS_BY_NAME, appliesTo } from '../src/protocol/operations';
import { identityBootstrapText } from '../src/protocol/program001';
import { deriveObservations, OBSERVATION_VOCABULARY } from '../src/research/phenotype';
import { contentHash, evaluate, ScrollContentSchema, validateScroll, type ScrollContent } from '../src/scrolls/scroll';
import { deterministicCalculator as F } from '../src/substrates/calculator';
import { exactRationalCalculator as Q } from '../src/substrates/rational';
import { getSubstrate, manifestHash, SUBSTRATES } from '../src/substrates/registry';

const ok = (v: unknown) => ({ ok: true, value: v });
const err = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) });

describe('deterministic-calculator (binary64)', () => {
  it('computes the closed operation set', () => {
    expect(F.apply('add', [0.1, 0.2])).toEqual(ok(0.30000000000000004));
    expect(F.apply('subtract', [5, 7])).toEqual(ok(-2));
    expect(F.apply('multiply', [6, 7])).toEqual(ok(42));
    expect(F.apply('divide', [1, 4])).toEqual(ok(0.25));
    expect(F.apply('power', [2, 10])).toEqual(ok(1024));
    expect(F.apply('power', [2, -2])).toEqual(ok(0.25));
    expect(F.apply('modulo', [-7, 3])).toEqual(ok(-1));
    expect(F.apply('multiply', [-0, 5])).toEqual(ok(0));
  });
  it('fails deterministically instead of producing non-finite values', () => {
    expect(F.apply('divide', [1, 0])).toEqual(err('division_by_zero'));
    expect(F.apply('modulo', [1, 0])).toEqual(err('division_by_zero'));
    expect(F.apply('power', [2, 0.5])).toEqual(err('invalid_exponent'));
    expect(F.apply('power', [2, 2000])).toEqual(err('invalid_exponent'));
    expect(F.apply('power', [0, -1])).toEqual(err('division_by_zero'));
    expect(F.apply('multiply', [1e308, 10])).toEqual(err('non_finite_result'));
    expect(F.apply('add', ['1/2', 1])).toEqual(err('type_error'));
    expect(F.apply('add', [1])).toEqual(err('arity_error'));
    expect(F.apply('eval', [1, 2])).toEqual(err('unknown_operation'));
  });
  it('is replayable: repeated application gives identical results', () => {
    const runs = Array.from({ length: 50 }, () => F.apply('power', [1.0000001, 1000]));
    expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});

describe('exact-rational-calculator', () => {
  it('is exact and reduces', () => {
    expect(Q.apply('add', [0.1, 0.2])).toEqual(ok('3/10'));
    expect(Q.apply('divide', [1, 3])).toEqual(ok('1/3'));
    expect(Q.apply('multiply', ['2/3', '3/4'])).toEqual(ok('1/2'));
    expect(Q.apply('subtract', ['1/2', '1/2'])).toEqual(ok('0'));
    expect(Q.apply('power', ['2/3', -2])).toEqual(ok('9/4'));
    expect(Q.apply('modulo', [-7, 3])).toEqual(ok('2'));
    expect(Q.apply('modulo', ['7/2', '-1'])).toEqual(ok('-1/2'));
    expect(Q.apply('add', [1e21, 1])).toEqual(ok('1000000000000000000001'));
    expect(Q.apply('add', [1e-7, 0])).toEqual(ok('1/10000000'));
  });
  it('bounds magnitude and rejects bad values', () => {
    expect(Q.apply('divide', [1, 0])).toEqual(err('division_by_zero'));
    expect(Q.apply('power', [2, 65])).toEqual(err('invalid_exponent'));
    expect(Q.apply('power', ['99999999999999999999999999999999999999999999999999999999999999999999999999999', 64])).toEqual(err('magnitude_limit'));
    expect(Q.apply('add', ['1/0', 1])).toEqual(err('type_error'));
    expect(Q.apply('add', ['x', 1])).toEqual(err('type_error'));
  });
});

describe('substrate registry', () => {
  it('manifests are complete and hashed', () => {
    for (const s of SUBSTRATES) {
      expect(manifestHash(s.manifest)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(s.manifest.capabilities).toEqual(s.manifest.operations.map((o) => o.name));
    }
    expect(getSubstrate('model-session')?.manifest.status).toBe('unavailable');
    expect(getSubstrate('nope')).toBeUndefined();
  });
});

const parse = (x: unknown) => ScrollContentSchema.parse(x);
const none = () => undefined;

describe('Scroll validation and evaluation', () => {
  it('normalises ids and output; hashing is key-order independent', () => {
    const { content, issues } = validateScroll(parse({ purpose: 'p', inputs: ['a', 'b'], operations: [{ operation: 'add', arguments: ['a', 'b'] }] }), none);
    expect(issues).toEqual([]);
    expect(content.operations[0]).toEqual({ id: 's1', operation: 'add', arguments: ['a', 'b'] });
    expect(content.output).toBe('s1');
    const reordered = JSON.parse(JSON.stringify({ output: content.output, operations: content.operations, symbols: content.symbols, inputs: content.inputs, description: content.description, purpose: content.purpose }));
    expect(contentHash(reordered)).toBe(contentHash(content));
  });
  it('reports every static problem', () => {
    const { issues } = validateScroll(
      parse({ purpose: 'p', inputs: ['a'], operations: [{ id: 'a', operation: 'nope', arguments: ['b'] }, { scroll: { scroll_id: 'SCR-001', version: 1 }, arguments: [] }], output: 'zz' }),
      none,
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['operations.0.arguments.0', 'operations.0.operation', 'operations.0.id', 'operations.1.scroll', 'output']));
  });
  it('evaluates compositions deterministically and records nested steps', () => {
    const mult: ScrollContent = validateScroll(parse({ purpose: 'm', inputs: ['a', 'b'], operations: [{ operation: 'multiply', arguments: ['a', 'b'] }] }), none).content;
    const lookup = (r: { scroll_id: string; version: number }) => (r.scroll_id === 'SCR-001' && r.version === 1 ? mult : undefined);
    const cube = validateScroll(
      parse({ purpose: 'cube', inputs: ['x'], operations: [{ id: 'sq', scroll: { scroll_id: 'SCR-001', version: 1 }, arguments: ['x', 'x'] }, { id: 'cu', scroll: { scroll_id: 'SCR-001', version: 1 }, arguments: ['sq', 'x'] }] }),
      lookup,
    ).content;
    const r1 = evaluate(cube, { x: 3 }, lookup, F);
    const r2 = evaluate(cube, { x: 3 }, lookup, F);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ status: 'completed', outputs: { cu: 27 } });
    expect(r1.steps.map((s) => s.path)).toEqual(['sq/s1', 'sq', 'cu/s1', 'cu']);
    expect(evaluate(cube, { x: '1/2' }, lookup, Q)).toMatchObject({ outputs: { cu: '1/8' } });
  });
  it('stops at the first failure and names where', () => {
    const c = validateScroll(parse({ purpose: 'p', inputs: ['a'], symbols: { z: 0 }, operations: [{ id: 'q', operation: 'divide', arguments: ['a', 'z'] }, { operation: 'add', arguments: ['q', 1] }] }), none).content;
    const r = evaluate(c, { a: 1 }, none, F);
    expect(r).toMatchObject({ status: 'failed', error: { code: 'division_by_zero', at: 'q' } });
    expect(r.steps).toHaveLength(1);
  });
});

describe('observation vocabulary', () => {
  const ev = (version: number, operation: string, data: Record<string, unknown> = {}, session = 's') => ({ version, operation, actor: { session_id: session }, data });
  it('derives labels from history, not from content', () => {
    const labels = deriveObservations(
      [
        ev(1, 'create'),
        ev(2, 'embody', { session_id: 'a', model: { m: 1 } }),
        ev(3, 'execute', { scroll: { ref: 'SCR-001:v1' }, inputs_sha256: 'h1', status: 'failed' }),
        ev(4, 'execute', { scroll: { ref: 'SCR-001:v1' }, inputs_sha256: 'h1', status: 'completed', via_alias: { name: 'm', binding: 1 } }),
        ev(5, 'release'),
        ev(6, 'embody', { session_id: 'b', model: { m: 1 } }),
      ],
      true,
    );
    expect(labels).toEqual([
      ['IDENTITY_CREATED'],
      ['EMBODIMENT_ATTACHED'],
      ['EXECUTION', 'EXECUTION_FAILED'],
      ['EXECUTION', 'ALIAS_RESOLVED', 'REUSE', 'OPERATION_REPEATED', 'RETRY'],
      ['EMBODIMENT_RELEASED'],
      ['EMBODIMENT_ATTACHED', 'SESSION_CHANGED', 'RECOVERY'],
    ]);
    for (const l of labels.flat()) expect(OBSERVATION_VOCABULARY).toHaveProperty(l);
  });
});

describe('Program 001 authority (pure)', () => {
  const identity = { id: 'R1', visibility: 'unlisted', lifecycle: 'active', kind: 'agent_identity' } as ResourceRow;
  const cap = (scopes: string[]): VerifiedCapability => ({ id: 'cap_0000000000', resource_id: 'R1', kind: 'delegation', session_id: 's', agent_id: null, scopes: scopes as never, expires_at: null });
  it('scopes gate identity operations; identity-only operations do not apply to plain resources', () => {
    expect(authorize(OPERATIONS_BY_NAME.execute, identity, null).ok).toBe(false);
    expect(authorize(OPERATIONS_BY_NAME.execute, identity, cap(['scroll'])).ok).toBe(false);
    expect(authorize(OPERATIONS_BY_NAME.execute, identity, cap(['execute'])).ok).toBe(true);
    expect(authorize(OPERATIONS_BY_NAME.embody, identity, cap(['read'])).ok).toBe(false);
    expect(appliesTo(OPERATIONS_BY_NAME.execute, 'continuity_resource')).toBe(false);
    expect(appliesTo(OPERATIONS_BY_NAME.fork, 'agent_identity')).toBe(false);
    expect(appliesTo(OPERATIONS_BY_NAME.append, 'agent_identity')).toBe(true);
  });
});

describe('Program 001 documentation stays in sync', () => {
  const protocolMd = readFileSync('PROTOCOL.md', 'utf8');
  it('PROTOCOL.md contains the identity bootstrap verbatim', () => {
    expect(protocolMd).toContain(identityBootstrapText());
  });
  it('every Program 001 operation has a machine-readable contract', () => {
    for (const o of OPERATIONS.filter((x) => x.applies_to?.includes('agent_identity') && x.applies_to.length === 1)) {
      expect(o.purpose && o.authority_text && o.input && o.output && o.side_effects && o.provenance, o.name).toBeTruthy();
      if (o.mutation) expect(o.payload, o.name).toBeDefined();
    }
  });
});
