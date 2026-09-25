/**
 * ACSP protocol harness CLI.
 *
 *   npm run harness                              all scenarios, in-process, PGlite
 *   npm run harness -- core-demonstration -v     one scenario with its transcript
 *   npm run harness -- --db postgres             against ACSP_TEST_DATABASE_URL / DATABASE_URL
 *   npm run harness -- --base-url https://…      against a running deployment
 *   npm run harness -- --list
 */
import { runScenario, type ScenarioOutcome } from './runner';
import { SCENARIOS } from './scenarios';
import type { WorldOptions } from './world';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('-') && !['--db', '--base-url', '--seed'].includes(args[i - 1] ?? ''));

if (flag('--list')) {
  for (const s of SCENARIOS) console.log(`${s.name.padEnd(22)} ${s.description}`);
  process.exit(0);
}

const verbose = flag('-v') || flag('--verbose');
const opts: WorldOptions = {
  db: value('--db') === 'postgres' ? 'postgres' : 'pglite',
  baseUrl: value('--base-url'),
  seed: value('--seed') ? Number(value('--seed')) : undefined,
};
const selected = positional.length ? SCENARIOS.filter((s) => positional.includes(s.name)) : SCENARIOS;
if (positional.length && selected.length !== positional.length) {
  console.error(`Unknown scenario(s): ${positional.filter((p) => !SCENARIOS.some((s) => s.name === p)).join(', ')}`);
  process.exit(2);
}

const target = opts.baseUrl ? `http → ${opts.baseUrl}` : `in-process · ${opts.db}`;
console.log(`ACSP/0.1 protocol harness — ${selected.length} scenario(s) — ${target}\n`);

const outcomes: ScenarioOutcome[] = [];
for (const s of selected) {
  if (verbose) console.log(`[${s.name}] ${s.description}`);
  const o = await runScenario(s, opts, verbose ? (l) => console.log(l) : undefined);
  outcomes.push(o);
  const mark = o.status === 'passed' ? 'PASS' : o.status === 'skipped' ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${s.name.padEnd(22)} ${String(o.checks).padStart(3)} checks  ${o.ms} ms`);
  for (const f of o.failures) console.log(`      ✗ [${f.step}] ${f.message}`);
  if (o.error) console.log(`      ! ${o.error.split('\n').slice(0, 6).join('\n        ')}`);
  if (verbose) console.log('');
}

const failed = outcomes.filter((o) => o.status === 'failed');
const checks = outcomes.reduce((n, o) => n + o.checks, 0);
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} scenarios passed · ${checks} checks · ${outcomes.filter((o) => o.status === 'skipped').length} skipped`);
process.exit(failed.length ? 1 : 0);
