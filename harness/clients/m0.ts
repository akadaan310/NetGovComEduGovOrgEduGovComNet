/**
 * M0 — the deterministic client at the bottom of the low-model ladder.
 *
 * It is given ONLY a URL (and, in the second arm, a capability delivered out
 * of band). It knows the ACSP envelope and JSON, nothing else: every other
 * path it uses is discovered from documents it fetched (links, operation
 * entries, prepare intents). It never reads the database or engine.
 *
 * The same task and measurement dimensions are meant to be run later by
 * M1…M5 (models of increasing size) against the same surface, with no hidden
 * context. M0 establishes what the surface makes possible without
 * intelligence; it is not a benchmark of anything.
 */
import { PROTOCOL_VERSION } from '../../src/protocol/constants';
import { alternateJsonHref, type AcspClient, type HttpResult } from '../client';

export interface M0Task {
  /** Alias the task asks the client to (re)use. */
  alias: string;
  inputs: Record<string, number | string>;
}

export type Claim = 'PERFORMED' | 'PROPOSED' | 'REFUSED';

export interface M0Report {
  session_id: string;
  discovered: Record<'protocol' | 'identity' | 'state' | 'authority' | 'substrates' | 'scrolls' | 'operations' | 'aliases', boolean>;
  agent_id: string | null;
  may: string[];
  may_not: string[];
  alias_resolution: { alias: string; ref: string } | null;
  recovered_checkpoint: { number: number; sha256: string } | null;
  actions: { operation: string; status: number; claim: Claim; version: number | null; detail: unknown }[];
  outputs: unknown;
  checkpoint: { number: number; sha256: string } | null;
  requests: number;
  failures: number;
}

export class M0Client {
  private requests = 0;
  private failures = 0;
  private seq = 0;

  constructor(
    private readonly http: AcspClient,
    readonly session_id: string,
    private readonly token: string | null = null,
    private readonly keyPrefix = session_id,
  ) {}

  private async get(url: string, json = true): Promise<HttpResult> {
    this.requests++;
    const r = json ? await this.http.getJson(url, this.token) : await this.http.getHtml(url);
    if (r.status >= 400) this.failures++;
    return r;
  }

  private async post(url: string, operation: string, payload: unknown, expected_version?: number): Promise<HttpResult> {
    this.requests++;
    const body = {
      protocol: PROTOCOL_VERSION,
      operation,
      actor: { session_id: this.session_id, agent_id: 'm0-deterministic', kind: 'agent' },
      ...(expected_version !== undefined ? { expected_version } : {}),
      idempotency_key: `${this.keyPrefix}-m0-${++this.seq}`,
      payload,
    };
    const r = await this.http.postJson(url, body, this.token);
    if (r.status >= 400) this.failures++;
    return r;
  }

  async run(url: string, task: M0Task): Promise<M0Report> {
    const report: M0Report = {
      session_id: this.session_id,
      discovered: { protocol: false, identity: false, state: false, authority: false, substrates: false, scrolls: false, operations: false, aliases: false },
      agent_id: null,
      may: [],
      may_not: [],
      alias_resolution: null,
      recovered_checkpoint: null,
      actions: [],
      outputs: null,
      checkpoint: null,
      requests: 0,
      failures: 0,
    };

    // 1. The URL, as a browser would open it; find the machine representation.
    const page = await this.get(url, false);
    const jsonHref = alternateJsonHref(page.text);
    if (!jsonHref) return this.finish(report);
    let doc = (await this.get(jsonHref)).body;

    // 2. Protocol.
    const proto = (await this.get(doc.links.protocol_json)).body;
    report.discovered.protocol = proto?.protocol?.version === PROTOCOL_VERSION && !!proto.program_001;

    // 3. Identity, state, authority.
    report.discovered.identity = doc.type === 'agent_identity' && typeof doc.identity?.agent_id === 'string';
    report.agent_id = doc.identity?.agent_id ?? null;
    report.discovered.state = typeof doc.state?.version === 'number';
    report.discovered.authority = typeof doc.viewer?.summary === 'string' && Array.isArray(doc.operations);

    // 4. Substrates, Scrolls, operations, aliases — each through a discovered link.
    const subs = (await this.get(doc.links.substrates)).body;
    report.discovered.substrates = Array.isArray(subs.substrates) && subs.substrates.some((s: any) => s.status === 'available' && s.operations.length > 0);
    const scrolls = (await this.get(doc.links.scrolls)).body;
    report.discovered.scrolls = Array.isArray(scrolls.scrolls);
    const ops = (await this.get(doc.links.operations)).body;
    report.discovered.operations = Array.isArray(ops.operations);
    const alias = doc.aliases?.items?.find((a: any) => a.name === task.alias);
    report.discovered.aliases = !!alias;

    // 5. Recover from the latest checkpoint: verify it and resolve the alias from it.
    const cp = doc.identity.current_checkpoint;
    if (cp) {
      const snap = (await this.get(cp.href)).body.checkpoint;
      const inSnapshot = snap.snapshot.aliases?.find((a: any) => a.name === task.alias);
      report.recovered_checkpoint = { number: snap.number, sha256: snap.sha256 };
      if (inSnapshot) report.alias_resolution = { alias: task.alias, ref: inSnapshot.target.ref };
    }
    if (alias) {
      const live = (await this.get(alias.href)).body.alias;
      report.alias_resolution = { alias: task.alias, ref: live.target.ref };
    }

    // 6. Decide what it may and may not do, from the operation entries alone.
    const permitted = (name: string) => doc.operations.find((o: any) => o.name === name)?.permitted_for_viewer === true;
    const entry = (name: string) => doc.operations.find((o: any) => o.name === name);
    report.may = doc.operations.filter((o: any) => o.permitted_for_viewer).map((o: any) => o.name);
    report.may_not = doc.operations.filter((o: any) => !o.permitted_for_viewer).map((o: any) => o.name);

    const payload = { target: { alias: task.alias }, inputs: task.inputs };
    if (permitted('embody')) {
      const r = await this.post(entry('embody').href, 'embody', { model: { provider: 'none', model_id: 'm0-deterministic' } });
      report.actions.push({ operation: 'embody', status: r.status, claim: r.status === 200 ? 'PERFORMED' : 'REFUSED', version: r.body.version ?? null, detail: r.body.result?.embodiment?.id ?? r.body.error });
      doc = (await this.get(jsonHref)).body;
    }
    if (permitted('execute')) {
      const r = await this.post(entry('execute').href, 'execute', payload);
      const x = r.body.result?.execution;
      report.actions.push({ operation: 'execute', status: r.status, claim: r.status === 200 && x ? 'PERFORMED' : 'REFUSED', version: r.body.version ?? null, detail: x?.execution_id ?? r.body.error });
      report.outputs = x?.outputs ?? null;
      if (x && permitted('checkpoint')) {
        const c = await this.post(entry('checkpoint').href, 'checkpoint', { label: `${this.session_id}: continued`, note: 'M0 recovered and executed' });
        report.checkpoint = c.body.result?.checkpoint ? { number: c.body.result.checkpoint.number, sha256: c.body.result.checkpoint.sha256 } : null;
        report.actions.push({ operation: 'checkpoint', status: c.status, claim: c.status === 200 ? 'PERFORMED' : 'REFUSED', version: c.body.version ?? null, detail: report.checkpoint });
      }
    } else if (permitted('propose') && entry('execute')?.proposable) {
      // No authority: prepare, then propose. Never claim the execution happened.
      const prepared = (await this.get(entry('propose').prepare_href)).body;
      const r = await this.post(prepared.execution.href, 'propose', { operation: 'execute', payload, rationale: 'M0 has no execute authority' });
      report.actions.push({ operation: 'propose', status: r.status, claim: r.status === 200 ? 'PROPOSED' : 'REFUSED', version: r.body.version ?? null, detail: r.body.result?.proposal?.id ?? r.body.error });
    }
    return this.finish(report);
  }

  private finish(r: M0Report): M0Report {
    r.requests = this.requests;
    r.failures = this.failures;
    return r;
  }
}
