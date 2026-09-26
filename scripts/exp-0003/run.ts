/**
 * exp-0003 orchestrator — plays the HUMAN who passes URLs between sessions.
 *
 *   npm run exp:0003             run both flows, write experiments/exp-0003/{record.json,raw/}
 *   npm run exp:0003 -- --verify re-run and compare the normalised outcome hash with the committed record
 *
 * It starts the ACSP service (harness/serve.ts) as its own process, then runs
 * each session turn as a separate process with its own private directory. The
 * only thing it passes from one session to the next is the continuation URL
 * the previous session printed (and, in the delegation run, the one
 * capability the owner explicitly delegated to session-b).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { canonicalHash, canonicalJson } from '../../src/continuity/canonical';

const ROOT = process.cwd();
const EXP = join(ROOT, 'experiments', 'exp-0003');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const CAP = /acsp_cap_[0-9A-Z]{10}_[0-9A-Z]{32}/;

interface Turn {
  mode: string;
  argv: string[];
  env: Record<string, string>;
  dir: string;
  output: any;
  exit: number | null;
}

function runProcess(cmd: string, args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

async function startService() {
  const p = spawn(TSX, ['harness/serve.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const base: string = await new Promise((resolve, reject) => {
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]).acsp);
    });
    p.on('exit', (c) => reject(new Error(`service exited ${c}`)));
  });
  return { base, pid: p.pid, stop: () => p.kill('SIGTERM') };
}

async function turn(mode: string, argv: string[], dir: string, extraEnv: Record<string, string> = {}): Promise<Turn> {
  // A minimal environment: no inherited variables beyond PATH, so nothing leaks in by accident.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', PRIVATE_DIR: dir, ...extraEnv };
  const r = await runProcess(TSX, ['scripts/exp-0003/agent.ts', mode, ...argv], env);
  let output: any = null;
  try {
    output = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
  } catch {
    output = { error: `no output; stderr: ${r.stderr.slice(0, 2000)}` };
  }
  return { mode, argv, env: { ...env, PATH: '[inherited PATH]', ...(env.ACSP_CAPABILITY ? { ACSP_CAPABILITY: '[REDACTED CAPABILITY]' } : {}) }, dir, output, exit: r.code };
}

/** What crossed into a session from outside: argv and environment (before redaction). */
const leaked = (argv: string[], env: Record<string, string>, allowed: string | null) =>
  [...argv, ...Object.values(env)].some((v) => CAP.test(v) && v !== allowed);

async function proposalRun(base: string, work: string) {
  const dirs = { a: mkdtempSync(join(work, 'a-')), b: mkdtempSync(join(work, 'b-')), c: mkdtempSync(join(work, 'c-')) };
  const a1 = await turn('a-start', [base], dirs.a);
  const hrefA = a1.output.continuation as string; // ← the only thing the human passes to B
  const bArgv = [hrefA];
  const b = await turn('b', bArgv, dirs.b);
  const bRetry = await turn('b-retry', [], dirs.b); // B's own restarted process, B's own directory
  const hrefB = b.output.continuation as string; // ← the only thing the human passes back to A
  const a2 = await turn('a-review', [hrefB], dirs.a); // A's new process; A's own directory (its saved capability)
  const hrefFinal = a2.output.continuation as string; // ← the only thing the human passes to C
  const c = await turn('c', [hrefFinal], dirs.c);
  const passed = { to_b: bArgv, to_a_review: [hrefB], to_c: [hrefFinal] };
  const leaks = {
    into_b: leaked(bArgv, { PRIVATE_DIR: dirs.b }, null),
    into_c: leaked([hrefFinal], { PRIVATE_DIR: dirs.c }, null),
    b_received_secret: b.output.received_capability_secret,
    c_received_secret: c.output.received_capability_secret,
    b_dir_has_a_secret: readdirSync(dirs.b).some((f) => CAP.test(readFileSync(join(dirs.b, f), 'utf8'))),
  };
  return { turns: { a1, b, bRetry, a2, c }, passed, leaks, dirs };
}

async function delegationRun(base: string, work: string) {
  const dirs = { a: mkdtempSync(join(work, 'da-')), b: mkdtempSync(join(work, 'db-')), c: mkdtempSync(join(work, 'dc-')) };
  const a1 = await turn('a-start', [base, '--delegate', 'session-b'], dirs.a);
  const href = a1.output.continuation as string;
  const delegated = readFileSync(join(dirs.a, 'handover-for-human'), 'utf8').trim(); // the human hands this ONE token to B
  const owner = readFileSync(join(dirs.a, 'owner-capability'), 'utf8').trim();
  const b = await turn('b', [href], dirs.b, { ACSP_CAPABILITY: delegated });
  const c = await turn('c', [b.output.continuation], dirs.c);
  return {
    turns: { a1, b, c },
    passed: { to_b: [href], to_b_capability: '[the delegated capability, redacted]', to_c: [b.output.continuation] },
    leaks: {
      owner_token_given_to_b: delegated === owner,
      into_c: leaked([b.output.continuation], { PRIVATE_DIR: dirs.c }, null),
      c_received_secret: c.output.received_capability_secret,
    },
    dirs,
  };
}

function evaluate(p: Awaited<ReturnType<typeof proposalRun>>, d: Awaited<ReturnType<typeof delegationRun>>) {
  const { a1, b, bRetry, a2, c } = p.turns;
  const v = (r: any) => r && r.chain_ok && r.versions_contiguous && r.state_matches_latest && r.checkpoints_ok && r.records_schema_valid;
  const H = (id: string, ok: boolean, evidence: unknown) => ({ id, status: ok ? 'supported' : 'not_supported', evidence });
  const chain = c.output.causation_chain ?? [];
  return [
    H('H1', b.output.continuation_schema_valid && v(b.output.verification), { schema: b.output.continuation_schema_valid, verification: b.output.verification }),
    H('H2', b.output.authority.authenticated === false && !b.output.authority.permitted.includes('append') && b.output.authority.permitted.includes('propose') && b.output.append_without_capability.status === 401, { authority: b.output.authority, append: b.output.append_without_capability }),
    H('H3', b.output.propose.status === 200 && b.output.propose.causation_id === b.output.reference.operation_id && b.output.propose.identity_assurance === 'asserted', b.output.propose),
    H('H4', a2.output.accept.status === 200 && a2.output.accept.causation_source === 'derived' && a2.output.accept.causation_id === b.output.propose.operation_id && a2.output.accept.events === 2 && a2.output.accept.on_behalf_of === 'session-b', a2.output.accept),
    H('H5', c.output.continuation_schema_valid && v(c.output.verification) && c.output.chain_ids.includes(b.output.propose.operation_id) && c.output.chain_ids.includes(a1.output.first_cited_operation) && c.output.correlation_ids.length === 1, { chain, correlation_ids: c.output.correlation_ids }),
    H('H6', !p.leaks.into_b && !p.leaks.into_c && !p.leaks.b_received_secret && !p.leaks.c_received_secret && !p.leaks.b_dir_has_a_secret && !d.leaks.owner_token_given_to_b && !d.leaks.into_c && !d.leaks.c_received_secret, { proposal_run: p.leaks, delegation_run: d.leaks }),
    H('H7', c.output.replay_without_capability.status === 401 && c.output.replay_without_capability.version_unchanged && b.output.resolve_without_capability.status === 401, { c_replay: c.output.replay_without_capability, b_resolve: b.output.resolve_without_capability }),
    H('H8', bRetry.output.status === 200 && bRetry.output.replayed === true && bRetry.output.operation_id === b.output.propose.operation_id && bRetry.output.proposals === 1, bRetry.output),
    H('H9', d.turns.b.output.append?.status === 200 && d.turns.b.output.append.identity_assurance === 'capability' && d.turns.b.output.append.capability_kind === 'delegation' && (d.turns.c.output.causation_chain ?? []).some((g: any) => g.operation_type === 'delegate' && g.actor === 'session-a'), { b: d.turns.b.output.append, chain: d.turns.c.output.causation_chain }),
  ];
}

/** The deterministic part of the observations: no ids, hashes, times, ports or pids. */
function normalise(p: Awaited<ReturnType<typeof proposalRun>>, d: Awaited<ReturnType<typeof delegationRun>>, hyps: ReturnType<typeof evaluate>) {
  const ver = (r: any) => r && { operations: r.operations, chain_ok: r.chain_ok, versions_contiguous: r.versions_contiguous, state_matches_latest: r.state_matches_latest, checkpoints_ok: r.checkpoints_ok, records_schema_valid: r.records_schema_valid, problems: r.problems.length, graph: r.graph.map((g: any) => [g.operation_type, g.actor, g.identity_assurance, g.causation_source, g.from_version, g.to_version]) };
  return {
    proposal_run: {
      a_start: { statuses: p.turns.a1.output.statuses },
      b: { continuation_schema_valid: p.turns.b.output.continuation_schema_valid, verification: ver(p.turns.b.output.verification), authority: p.turns.b.output.authority, append_without_capability: p.turns.b.output.append_without_capability, propose: { status: p.turns.b.output.propose.status, identity_assurance: p.turns.b.output.propose.identity_assurance }, resolve_without_capability: p.turns.b.output.resolve_without_capability, received_capability_secret: p.turns.b.output.received_capability_secret },
      b_retry: { status: p.turns.bRetry.output.status, replayed: p.turns.bRetry.output.replayed, proposals: p.turns.bRetry.output.proposals },
      a_review: { viewer_is_owner: p.turns.a2.output.viewer_is_owner, verification: ver(p.turns.a2.output.verification), proposal_payload_hash_ok: p.turns.a2.output.proposal.payload_hash_ok, accept: { status: p.turns.a2.output.accept.status, causation_source: p.turns.a2.output.accept.causation_source, events: p.turns.a2.output.accept.events, on_behalf_of: p.turns.a2.output.accept.on_behalf_of } },
      c: { continuation_schema_valid: p.turns.c.output.continuation_schema_valid, verification: ver(p.turns.c.output.verification), causation_chain: p.turns.c.output.causation_chain, correlation_ids: p.turns.c.output.correlation_ids.length, owner: p.turns.c.output.owner, replay_without_capability: p.turns.c.output.replay_without_capability, received_capability_secret: p.turns.c.output.received_capability_secret },
      leaks: p.leaks,
      exits: Object.fromEntries(Object.entries(p.turns).map(([k, t]) => [k, t.exit])),
      separate_processes: new Set(Object.values(p.turns).map((t) => t.output.pid)).size === Object.keys(p.turns).length,
    },
    delegation_run: {
      b: { verification: ver(d.turns.b.output.verification), authority: d.turns.b.output.authority, append: { status: d.turns.b.output.append?.status, identity_assurance: d.turns.b.output.append?.identity_assurance, capability_kind: d.turns.b.output.append?.capability_kind } },
      c: { verification: ver(d.turns.c.output.verification), causation_chain: d.turns.c.output.causation_chain, replay_without_capability: d.turns.c.output.replay_without_capability },
      leaks: d.leaks,
      exits: Object.fromEntries(Object.entries(d.turns).map(([k, t]) => [k, t.exit])),
    },
    hypotheses: hyps.map((h) => ({ id: h.id, status: h.status })),
  };
}

function git() {
  const sh = (c: string) => execSync(c, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    return { commit: sh('git rev-parse HEAD'), branch: sh('git rev-parse --abbrev-ref HEAD'), dirty_worktree: sh('git status --porcelain').length > 0 };
  } catch {
    return { commit: null, branch: null, dirty_worktree: null };
  }
}

async function main() {
  const verify = process.argv.includes('--verify');
  const def = JSON.parse(readFileSync(join(EXP, 'definition.json'), 'utf8'));
  // Repository state is captured BEFORE the run writes anything (the first recorded run computed it
  // after writing raw/, which made a clean tree read as dirty).
  const repo = git();
  const work = mkdtempSync(join(tmpdir(), 'acsp-exp-0003-'));
  const service = await startService();
  let p, d;
  try {
    p = await proposalRun(service.base, work);
    d = await delegationRun(service.base, work);
  } finally {
    service.stop();
  }
  const hyps = evaluate(p, d).map((h) => ({ category: 'hypothesis', ...h, statement: def.hypotheses.find((x: any) => x.id === h.id).statement, criterion: def.hypotheses.find((x: any) => x.id === h.id).criterion }));
  const normalised = normalise(p, d, hyps);
  const outputHash = canonicalHash(normalised);
  for (const h of hyps) console.log(`${h.id.padEnd(3)} ${h.status.padEnd(14)} ${h.statement}`);
  console.log(`output_hash ${outputHash}`);

  if (process.argv.includes('--dry')) {
    // Debugging runs: print, write nothing. The report counts them.
    console.log(JSON.stringify(normalised, null, 1).slice(0, 4000));
    rmSync(work, { recursive: true, force: true });
    return;
  }
  if (verify) {
    const committed = JSON.parse(readFileSync(join(EXP, 'record.json'), 'utf8'));
    const same = committed.reproducibility.output_hash === outputHash;
    console.log(`committed   ${committed.reproducibility.output_hash}`);
    console.log(same ? 'REPRODUCED — every normalised observation and hypothesis outcome matches.' : 'DIVERGED');
    if (!same) {
      const a = JSON.parse(canonicalJson(committed.observations.normalised));
      for (const k of Object.keys(normalised)) if (canonicalJson(a[k]) !== canonicalJson((normalised as any)[k])) console.log(`  differs: ${k}`);
      process.exitCode = 1;
    }
    rmSync(work, { recursive: true, force: true });
    return;
  }

  // Raw evidence: each session's transcript (secrets redacted), outputs and what crossed between sessions.
  const raw = join(EXP, 'raw');
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const index: Record<string, string> = {};
  const save = (name: string, value: unknown) => {
    const text = JSON.stringify(value, null, 1).replace(new RegExp(CAP.source, 'g'), '[REDACTED CAPABILITY]') + '\n';
    writeFileSync(join(raw, name), text);
    index[name] = 'sha256:' + createHash('sha256').update(text).digest('hex');
  };
  for (const [run, r] of [['proposal', p], ['delegation', d]] as const) {
    for (const [k, t] of Object.entries(r.turns)) save(`${run}-${k}-output.json`, { mode: t.mode, argv: t.argv, env: t.env, exit: t.exit, output: t.output });
    for (const [who, dir] of Object.entries(r.dirs)) for (const f of readdirSync(dir).filter((f) => f.startsWith('transcript-'))) save(`${run}-${who}-${f}`, JSON.parse(readFileSync(join(dir, f), 'utf8')));
    save(`${run}-passed-between-sessions.json`, r.passed);
  }
  const record = {
    schema: 'acsp.experiment-record/0.1',
    experiment_id: 'exp-0003',
    title: def.title,
    question: def.question,
    claim_under_test: def.claim_under_test,
    run: { timestamp: new Date().toISOString() },
    repository: { url: 'https://github.com/akadaan310/NetGovComEduGovOrgEduGovComNet', ...repo },
    environment: { node: process.version, platform: process.platform, arch: process.arch, database: 'PGlite (in-memory) via harness/serve.ts' },
    protocol_versions: { server: 'ACSP/0.2', envelopes: 'ACSP/0.2' },
    definition: { file: 'experiments/exp-0003/definition.json', sha256: 'sha256:' + createHash('sha256').update(readFileSync(join(EXP, 'definition.json'))).digest('hex'), preregistered_in_commit: '6c04020' },
    operational_definitions: def.operational_definitions,
    observations: { category: 'observation', normalised, separate_process_ids: Object.fromEntries(Object.entries({ ...p.turns }).map(([k, t]) => [k, t.output.pid])) },
    hypotheses: hyps,
    interpretation: { category: 'interpretation', entries: [] },
    uncertainty: {
      category: 'uncertainty',
      notes: [
        'The agents are deterministic programs written with knowledge of the protocol. They show what the service permits, refuses and records; they do not show that a language-model session would discover and follow the same procedure. That is tested separately (llm_sessions).',
        'All processes run on one machine and reach the service over loopback HTTP. Isolation is by process, environment and private directory, not by machine.',
        'State digests are computed and served by the service; verification shows internal consistency of the served history, not that the service is honest.',
      ],
    },
    conclusions: { category: 'conclusion', entries: [] },
    llm_sessions: { category: 'observation', status: 'pending', file: 'experiments/exp-0003/llm-sessions.md' },
    raw: index,
    reproducibility: { output_hash: outputHash, hashed: 'observations.normalised (no ids, digests, times, ports, pids)', command: 'npm run exp:0003 -- --verify' },
  };
  writeFileSync(join(EXP, 'record.json'), JSON.stringify(record, null, 1) + '\n');
  rmSync(work, { recursive: true, force: true });
  console.log(`wrote experiments/exp-0003/record.json and ${Object.keys(index).length} raw files`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
