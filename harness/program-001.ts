/**
 * Program 001 runner: executes every Program 001 scenario (including
 * Experiments A and B and the fresh-session demonstration), prints the
 * measurements, and writes the run record and transition exports.
 *
 *   npm run program-001                      → research/experiments/results/
 *   npm run program-001 -- --out <dir>
 *
 * In-process, PGlite, seeded RNG and manual clock: two runs on the same code
 * produce the same ids, hashes and measurements.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalHash } from '../src/continuity/canonical';
import { PROTOCOL_VERSION } from '../src/protocol/constants';
import { runScenario } from './runner';
import { SCENARIOS } from './scenarios';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : path.join('research', 'experiments', 'results');
mkdirSync(out, { recursive: true });

const commit = (() => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() + (execSync('git status --porcelain', { encoding: 'utf8' }).trim() ? ' (+uncommitted changes)' : '');
  } catch {
    return 'unknown';
  }
})();

const selected = SCENARIOS.filter((s) => s.program === '001');
console.log(`Program 001 — ${selected.length} scenarios — ${PROTOCOL_VERSION} + program-001 — commit ${commit}\n`);
const outcomes = [];
for (const s of selected) {
  const o = await runScenario(s, { db: 'pglite' });
  outcomes.push(o);
  console.log(`${o.status === 'passed' ? 'PASS' : 'FAIL'}  ${s.name.padEnd(30)} ${String(o.checks).padStart(3)} checks`);
  for (const f of o.failures) console.log(`      ✗ [${f.step}] ${f.message}`);
  if (o.error) console.log(`      ! ${o.error.split('\n')[0]}`);
  for (const [k, v] of Object.entries(o.measurements)) console.log(`      ≡ ${k} = ${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(o.artifacts)) {
    const file = path.join(out, `${s.name}.${k}.json`);
    writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
    console.log(`      → ${file}`);
  }
}

const record = {
  program: '001',
  protocol: PROTOCOL_VERSION,
  extensions: ['program-001'],
  commit,
  environment: { node: process.version, database: 'pglite (in-process)', clock: 'ManualClock', random: 'SeededRandom(42)' },
  epistemic_status: 'SIMULATED actors (deterministic harness code) exercising the real HTTP handler. No model was run; model fields are declared labels.',
  summary: {
    scenarios: outcomes.length,
    passed: outcomes.filter((o) => o.status === 'passed').length,
    checks: outcomes.reduce((n, o) => n + o.checks, 0),
    failures: outcomes.flatMap((o) => o.failures.map((f) => ({ scenario: o.name, ...f }))),
  },
  outcomes: outcomes.map(({ artifacts, ms: _ms, ...o }) => ({ ...o, artifacts: Object.keys(artifacts) })),
};
const recordHash = canonicalHash({ ...record, commit: undefined });
writeFileSync(path.join(out, 'program-001-run.json'), JSON.stringify({ ...record, deterministic_sha256: recordHash }, null, 2) + '\n');
console.log(`\n${record.summary.passed}/${record.summary.scenarios} passed · ${record.summary.checks} checks · run record ${recordHash}`);
console.log(`→ ${path.join(out, 'program-001-run.json')}`);
process.exit(record.summary.passed === record.summary.scenarios ? 0 : 1);
