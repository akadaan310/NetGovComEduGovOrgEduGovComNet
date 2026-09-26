/**
 * ACSP/0.2 unit and integration tests that are not scenarios: registry
 * invariants, the template interpreter, schema files, and atomicity of a
 * multi-effect extension that fails part-way.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveTemplate } from '../src/continuity/extensions';
import { definitionOf } from '../src/continuity/operational';
import { INVARIANTS, INVARIANTS_V02 } from '../src/protocol/constants';
import {
  EFFECT_OPERATIONS,
  ENABLEABLE_STATUSES,
  EXECUTABLE_STATUSES,
  EXTENSIONS,
  EXTENSIONS_BY_NAME,
  EXTENSION_NAME_RE,
  type ExtensionDefinition,
} from '../src/protocol/extensions';
import { OPERATIONS, SEMANTICS, semanticsOf } from '../src/protocol/operations';
import { jsonSchemaOf, OperationDefinitionSchema, PUBLISHED_SCHEMAS, type SchemaName } from '../src/protocol/schemas';
import { createWorld } from '../harness/world';

describe('core operation semantics', () => {
  it('every core operation has preconditions, a transition and (for mutations) idempotency', () => {
    for (const o of OPERATIONS) {
      const s = semanticsOf(o.name);
      expect(s.qualified_name).toBe(`core:${o.name}`);
      expect(s.preconditions.length, o.name).toBeGreaterThan(0);
      expect(s.transition, o.name).toMatch(/S_n|∅/);
      if (o.mutation) expect(s.idempotency, o.name).not.toBeNull();
      else expect(s.idempotency, o.name).toBeNull();
    }
    expect(Object.keys(SEMANTICS).sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });
  it('the 0.1 invariants are a prefix of the 0.2 invariants', () => {
    expect(INVARIANTS_V02.slice(0, INVARIANTS.length)).toEqual([...INVARIANTS]);
  });
});

describe('extension registry invariants', () => {
  it('names, effects, statuses and evidence', () => {
    for (const e of EXTENSIONS) {
      expect(e.name, e.name).toMatch(EXTENSION_NAME_RE);
      expect(e.name.split(':')[1]).toBe(e.namespace);
      expect(e.effects.length).toBeGreaterThan(0);
      for (const f of e.effects) expect(EFFECT_OPERATIONS, `${e.name}: ${f.operation}`).toContain(f.operation);
      expect(e.history.length).toBeGreaterThan(0);
      expect(e.history[e.history.length - 1].status, `${e.name}: last history entry is its status`).toBe(e.status);
      if (['validated', 'promoted'].includes(e.status)) {
        const promo = e.history.find((h) => h.status === e.status)!;
        expect(promo.evidence?.length, `${e.name}: ${e.status} needs evidence`).toBeGreaterThan(0);
      }
      expect(OperationDefinitionSchema.safeParse(definitionOf(e)).success, e.name).toBe(true);
    }
    for (const s of ENABLEABLE_STATUSES) expect(EXECUTABLE_STATUSES).toContain(s);
    expect(EXECUTABLE_STATUSES).not.toContain('draft');
    expect(EXECUTABLE_STATUSES).not.toContain('retired');
  });
  it('validated evidence names checks that exist in the harness', () => {
    const src = readFileSync('harness/scenarios/extensions.ts', 'utf8');
    const e = EXTENSIONS_BY_NAME['ext:acsp.review:record_decision'];
    for (const ev of e.history.find((h) => h.status === 'validated')!.evidence!) {
      const words = ev.replace('harness: extensions / ', '').split(' ').filter((w) => w.length > 3);
      expect(words.some((w) => src.toLowerCase().includes(w.toLowerCase())), ev).toBe(true);
    }
  });
});

describe('template interpreter', () => {
  it('substitutes once and never re-interprets substituted data', () => {
    const t = { title: { $input: 'x' }, n: { $step: 0, path: 'tok.id' }, refs: [{ tok: { $input: 'y' } }], k: 'literal' };
    const out = resolveTemplate(t, { x: { $input: 'y' }, y: 'TOK-001' }, [{ result: { tok: { id: 'TOK-009' } } }]);
    expect(out).toEqual({ title: { $input: 'y' }, n: 'TOK-009', refs: [{ tok: 'TOK-001' }], k: 'literal' });
  });
});

describe('published schemas', () => {
  it('schemas/*.schema.json are generated from src/protocol/schemas.ts (npm run schemas)', () => {
    for (const name of Object.keys(PUBLISHED_SCHEMAS) as SchemaName[]) {
      expect(JSON.parse(readFileSync(`schemas/${name}.schema.json`, 'utf8')), name).toEqual(JSON.parse(JSON.stringify(jsonSchemaOf(name))));
    }
  });
});

describe('extension atomicity', () => {
  it('a failure in the second effect leaves no trace of the first', async () => {
    // A test-only definition, registered in this process only: append, then annotate a TOK that does not exist.
    const probe: ExtensionDefinition = {
      name: 'ext:acsp.test:half_fails',
      namespace: 'acsp.test',
      version: '1',
      status: 'experimental',
      description: 'test only',
      input: z.strictObject({ title: z.string() }),
      output: '',
      effects: [
        { operation: 'append', payload: { type: 'observation', title: { $input: 'title' } } },
        { operation: 'annotate', payload: { tok_id: 'TOK-999', kind: 'comment', content: 'never' } },
      ],
      idempotency: { request: 'replay', repeat: 'new_effect', note: '' },
      security: ['test only'],
      history: [{ status: 'experimental', protocol: 'ACSP/0.2', note: 'test only' }],
    };
    EXTENSIONS_BY_NAME[probe.name] = probe;
    const w = await createWorld();
    try {
      const a = w.actor('a', { session: 'session-a' });
      const rid = (await a.create({ title: 'atomicity' })).body.resource_id;
      const v = await a.version(rid);
      // Enabling validates against the registry, which now contains the probe.
      expect((await a.update(rid, { enabled_extensions: [probe.name] }, { expected_version: v })).status).toBe(200);
      const before = await a.getJson(`/r/${rid}/op.json`);
      const res = await a.op(rid, probe.name, { title: 'should vanish' });
      expect(res.status).toBe(404);
      const after = await a.getJson(`/r/${rid}/op.json`);
      expect(after.body.current_version).toBe(before.body.current_version);
      expect(after.body.operations.length).toBe(before.body.operations.length);
      expect((await a.inspect(rid)).body.knowledge.items).toEqual([]);
    } finally {
      delete EXTENSIONS_BY_NAME[probe.name];
      await w.close();
    }
  });
});

describe('PROTOCOL.md stays in sync with ACSP/0.2', () => {
  const md = readFileSync('PROTOCOL.md', 'utf8');
  it('lists every invariant, schema and 0.2 route', () => {
    for (const inv of INVARIANTS_V02) expect(md, inv).toContain(inv.replace(/\.$/, ''));
    for (const name of Object.keys(PUBLISHED_SCHEMAS)) expect(md, name).toContain(name);
    for (const route of ['/r/{id}/op/{operation_id}', '/r/{id}/continue', '/r/{id}/state', '/r/{id}/proposals/{proposalId}', '/extensions', '/schemas']) expect(md, route).toContain(route);
  });
  it('the repeat-semantics table matches the registry', () => {
    const row = md.split('\n').map((l) => l.trim()).find((l) => l.startsWith('| create, append'))!;
    const [newEffect, refused] = row.split('|').slice(1, 3);
    for (const [name, s] of Object.entries(SEMANTICS)) {
      if (!s.idempotency) continue;
      const cell = s.idempotency.repeat === 'new_effect' ? newEffect : refused;
      expect(cell, `${name} is ${s.idempotency.repeat}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
