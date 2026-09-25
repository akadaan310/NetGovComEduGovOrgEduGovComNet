import type { Actor } from '../actors';
import type { Scenario, T } from '../scenario';

/** Create a resource owned by `owner`; returns its id. */
export async function setup(t: T, owner: Actor, title = 'Scenario resource', extra: Record<string, unknown> = {}): Promise<string> {
  const res = await owner.create({ title, ...extra });
  t.status(res, 201, `create "${title}"`);
  return res.body.resource_id;
}

export const lifecycle: Scenario = {
  name: 'lifecycle',
  description: 'create → inspect → append → annotate → update → checkpoint → close; closed resources stay readable and forkable.',
  async run(w, t) {
    const a = w.actor('a', { session: 'session-a' });
    const rid = await t.step('create', () => setup(t, a, 'Lifecycle'));

    await t.step('inspect a fresh resource', async () => {
      const d = (await a.inspect(rid)).body;
      t.eq(d.state.lifecycle, 'active', 'active');
      t.eq(d.state.version, 1, 'version 1');
      t.eq(d.checkpoints.map((c: any) => c.number), [0], 'only genesis checkpoint');
      t.eq(d.knowledge.items, [], 'no knowledge');
      t.eq(d.viewer.is_owner, true, 'creator holds the owner capability');
    });

    await t.step('append, annotate, update', async () => {
      t.status(await a.append(rid, { type: 'question', title: 'Why?' }), 200, 'append question');
      const ann = await a.annotate(rid, { tok_id: 'TOK-001', kind: 'comment', content: 'Still open.' });
      t.status(ann, 200, 'annotate');
      t.eq(ann.body.result.annotation.id, 'ANN-001', 'annotation id');
      const v = await a.version(rid);
      const up = await a.update(rid, { focus: 'Answer the question.' }, { expected_version: v });
      t.status(up, 200, 'update focus');
      t.eq(up.body.result.changes, { focus: { from: '', to: 'Answer the question.' } }, 'update records before/after');
      const noop = await a.update(rid, { focus: 'Answer the question.' }, { expected_version: v + 1 });
      t.status(noop, 422, 'update that changes nothing', 'invalid_payload');
      const tok = (await a.getJson(`/r/${rid}/knowledge/TOK-001`)).body.tok;
      t.eq(tok.annotations.length, 1, 'annotation attached; TOK itself unchanged');
      t.eq(tok.title, 'Why?', 'TOK content unchanged');
    });

    await t.step('checkpoint then close', async () => {
      const cp = await a.checkpoint(rid, { label: 'before close' });
      t.eq(cp.body.result.checkpoint.number, 1, 'checkpoint 1');
      const v = await a.version(rid);
      const closed = await a.close(rid, { reason: 'Question answered elsewhere.' }, { expected_version: v });
      t.status(closed, 200, 'close');
      t.eq(closed.body.result.lifecycle, 'closed', 'lifecycle closed');
    });

    await t.step('closed resource refuses mutation but stays readable and forkable', async () => {
      t.status(await a.append(rid, { type: 'finding', title: 'late' }), 409, 'append after close', 'resource_closed');
      t.status(await a.checkpoint(rid, { label: 'late' }), 409, 'checkpoint after close', 'resource_closed');
      const d = (await a.inspect(rid)).body;
      t.eq(d.state.lifecycle, 'closed', 'still readable, lifecycle closed');
      t.check(d.operations.find((o: any) => o.name === 'append').permitted_for_viewer === false, 'append no longer permitted');
      t.check(d.next_valid_actions.some((n: any) => n.action === 'fork'), 'fork suggested');
      const b = w.actor('b', { session: 'session-b' });
      const f = await b.fork(rid, { title: 'Continuation' });
      t.status(f, 201, 'fork a closed resource');
    });
  },
};
