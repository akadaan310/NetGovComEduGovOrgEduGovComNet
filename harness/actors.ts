/**
 * Simulated participants. An actor holds ONLY the capabilities explicitly
 * handed to it (receive), which is how the harness models session isolation.
 */
import { PROTOCOL_VERSION } from '../src/protocol/constants';
import type { AcspClient, HttpResult } from './client';

export interface ActorOptions {
  session?: string;
  agent?: string | null;
  kind?: 'agent' | 'human' | 'system';
  /** Prefix for generated idempotency keys (unique per run against shared deployments). */
  keyPrefix?: string;
}

export interface OpOptions {
  expected_version?: number;
  key?: string;
  /** Override the credential: a token, or null to send none. Default: the actor's own token for the resource. */
  token?: string | null;
  /** Override the actor block (e.g. to attempt impersonation). */
  actor?: Record<string, unknown>;
  /** Send this exact body instead of building an envelope. */
  raw?: unknown;
}

export class Actor {
  readonly session_id: string;
  readonly agent_id: string | null;
  readonly kind: 'agent' | 'human' | 'system';
  private readonly tokens = new Map<string, string>();
  private seq = 0;
  private readonly keyPrefix: string;

  constructor(
    readonly name: string,
    readonly client: AcspClient,
    opts: ActorOptions = {},
  ) {
    this.session_id = opts.session ?? `session-${name}`;
    this.agent_id = opts.agent === undefined ? name : opts.agent;
    this.kind = opts.kind ?? 'agent';
    this.keyPrefix = opts.keyPrefix ?? this.session_id;
  }

  /** Explicitly give this actor a capability (as a human would, out of band). */
  receive(resourceId: string, token: string): void {
    this.tokens.set(resourceId, token);
  }
  token(resourceId: string): string | undefined {
    return this.tokens.get(resourceId);
  }
  /** Simulate the session ending: it loses every capability it held. */
  forget(): void {
    this.tokens.clear();
  }

  nextKey(): string {
    return `${this.keyPrefix}-k${String(++this.seq).padStart(4, '0')}`;
  }

  envelope(operation: string, payload: unknown, o: OpOptions = {}, key = o.key ?? this.nextKey()) {
    return {
      protocol: PROTOCOL_VERSION,
      operation,
      actor: o.actor ?? { session_id: this.session_id, ...(this.agent_id ? { agent_id: this.agent_id } : {}), kind: this.kind },
      ...(o.expected_version !== undefined ? { expected_version: o.expected_version } : {}),
      idempotency_key: key,
      payload,
    };
  }

  /** Perform any mutating operation. Never throws on protocol errors. */
  async op(resourceId: string | null, operation: string, payload: unknown, o: OpOptions = {}): Promise<HttpResult> {
    const token = o.token !== undefined ? o.token : resourceId ? this.tokens.get(resourceId) : undefined;
    const path = resourceId ? `/r/${resourceId}/operations` : '/r';
    const res = await this.client.postJson(path, o.raw ?? this.envelope(operation, payload, o), token);
    // Keep capabilities minted for this actor in its own responses (create/fork owner tokens).
    const oc = res.body?.result?.owner_capability;
    if (res.status === 201 && oc?.token) this.receive(res.body.resource_id, oc.token);
    return res;
  }

  create(payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(null, 'create', payload, o);
  }
  append(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'append', payload, o);
  }
  annotate(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'annotate', payload, o);
  }
  update(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'update', payload, o);
  }
  supersede(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'supersede', payload, o);
  }
  checkpoint(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'checkpoint', payload, o);
  }
  fork(rid: string, payload: Record<string, unknown> = {}, o: OpOptions = {}) {
    return this.op(rid, 'fork', payload, o);
  }
  delegate(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'delegate', payload, o);
  }
  revoke(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'revoke', payload, o);
  }
  handoff(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'handoff', payload, o);
  }
  acknowledge(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'acknowledge', payload, o);
  }
  propose(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'propose', payload, o);
  }
  resolveProposal(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'resolve_proposal', payload, o);
  }
  close(rid: string, payload: Record<string, unknown>, o: OpOptions = {}) {
    return this.op(rid, 'close', payload, o);
  }

  // ── reads ──
  inspect(rid: string, token: string | null | undefined = this.tokens.get(rid)) {
    return this.client.getJson(`/r/${rid}`, token);
  }
  async version(rid: string): Promise<number> {
    return (await this.inspect(rid)).body.state.version;
  }
  openHtml(url: string) {
    return this.client.getHtml(url);
  }
  getJson(path: string, token: string | null | undefined = undefined) {
    return this.client.getJson(path, token);
  }
}
