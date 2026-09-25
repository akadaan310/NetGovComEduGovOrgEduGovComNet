import { T, type Scenario } from './scenario';
import { createWorld, type WorldOptions } from './world';

export interface ScenarioOutcome {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  checks: number;
  failures: { step: string; message: string }[];
  error?: string;
  ms: number;
}

export async function runScenario(s: Scenario, opts: WorldOptions = {}, log?: (line: string) => void): Promise<ScenarioOutcome> {
  const started = Date.now();
  if (opts.baseUrl && (s.needsClock || s.needsDatabase)) {
    return { name: s.name, status: 'skipped', checks: 0, failures: [], ms: 0 };
  }
  const world = await createWorld({ ...opts, config: { ...opts.config, ...s.config } });
  const t = new T(s.name, log);
  let error: string | undefined;
  try {
    await s.run(world, t);
  } catch (err) {
    error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } finally {
    await world.close();
  }
  const failures = t.failures.map(({ step, message }) => ({ step, message }));
  return {
    name: s.name,
    status: failures.length || error ? 'failed' : 'passed',
    checks: t.results.length,
    failures,
    error,
    ms: Date.now() - started,
  };
}
