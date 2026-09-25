/**
 * Every harness scenario as a test. PGlite always; real Postgres too when
 * ACSP_TEST_DATABASE_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { runScenario } from '../harness/runner';
import { SCENARIOS } from '../harness/scenarios';

const targets: ('pglite' | 'postgres')[] = process.env.ACSP_TEST_DATABASE_URL ? ['pglite', 'postgres'] : ['pglite'];

for (const db of targets) {
  describe(`protocol harness (${db})`, () => {
    for (const s of SCENARIOS) {
      it(`${s.name}: ${s.description}`, async () => {
        const o = await runScenario(s, { db });
        expect(o.error, o.error).toBeUndefined();
        expect(o.failures, o.failures.map((f) => `[${f.step}] ${f.message}`).join('\n')).toEqual([]);
        expect(o.checks).toBeGreaterThan(0);
      });
    }
  });
}
