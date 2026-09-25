/** Scenario and assertion primitives. */
import type { World, WorldOptions } from './world';

export interface Scenario {
  name: string;
  description: string;
  /** Needs a controllable clock (skipped against remote deployments). */
  needsClock?: boolean;
  /** Needs direct database access (skipped against remote deployments). */
  needsDatabase?: boolean;
  /** Custom world configuration. */
  config?: WorldOptions['config'];
  run(world: World, t: T): Promise<void>;
}

export interface CheckResult {
  step: string;
  ok: boolean;
  message: string;
}

export class T {
  readonly results: CheckResult[] = [];
  private current = '(setup)';
  private stepNo = 0;
  constructor(
    readonly scenario: string,
    readonly log: (line: string) => void = () => undefined,
  ) {}

  async step<R>(label: string, fn: () => Promise<R>): Promise<R> {
    this.current = `${String(++this.stepNo).padStart(2, '0')} ${label}`;
    this.log(`  step ${this.current}`);
    return fn();
  }

  check(cond: unknown, message: string): boolean {
    const ok = Boolean(cond);
    this.results.push({ step: this.current, ok, message });
    this.log(`    ${ok ? '✓' : '✗'} ${message}`);
    return ok;
  }

  eq(actual: unknown, expected: unknown, message: string): boolean {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return this.check(ok, ok ? message : `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  /** Assert an HTTP result has the given status (and error code, for failures). */
  status(res: { status: number; body: any }, status: number, message: string, code?: string): boolean {
    const gotCode = res.body?.error?.code;
    const ok = res.status === status && (code === undefined || gotCode === code);
    const detail = ok ? '' : ` — got ${res.status}${gotCode ? ` ${gotCode}` : ''}${res.body?.error?.message ? ` (${res.body.error.message})` : ''}`;
    return this.check(ok, `${message} → ${status}${code ? ` ${code}` : ''}${detail}`);
  }

  get failures(): CheckResult[] {
    return this.results.filter((r) => !r.ok);
  }
}
