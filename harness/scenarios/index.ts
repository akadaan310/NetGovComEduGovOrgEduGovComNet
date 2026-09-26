import type { Scenario } from '../scenario';
import { authorityMatrix } from './authority';
import { coreDemonstration } from './core-demonstration';
import { lifecycle } from './lifecycle';
import { concurrency, failures, getSafety, humanFormPath, rateLimits, representations, restricted } from './robustness';
import { checkpointResume, fork, provenanceHistory, supersession } from './structure';
import { handoff, proposals } from './transfer';
import { p001Authority, p001Discover, p001Executions, p001GetSafety, p001Proposals, p001Provenance } from './p001-execution';
import { p001ExpA, p001ExpB, p001FreshSession } from './p001-experiments';
import { p001Aliases, p001Identity, p001Scrolls, p001Substrates } from './p001-identity';

export const SCENARIOS: Scenario[] = [
  coreDemonstration,
  lifecycle,
  authorityMatrix,
  handoff,
  proposals,
  supersession,
  fork,
  provenanceHistory,
  checkpointResume,
  failures,
  concurrency,
  getSafety,
  representations,
  restricted,
  humanFormPath,
  rateLimits,
  // Program 001
  p001Identity,
  p001Substrates,
  p001Scrolls,
  p001Aliases,
  p001Executions,
  p001Authority,
  p001GetSafety,
  p001Proposals,
  p001Discover,
  p001Provenance,
  p001ExpA,
  p001ExpB,
  p001FreshSession,
];
