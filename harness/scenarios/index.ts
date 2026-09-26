import type { Scenario } from '../scenario';
import { authorityMatrix } from './authority';
import { computationEnvelope } from './computation';
import { coreDemonstration } from './core-demonstration';
import { lifecycle } from './lifecycle';
import { interSessionHandoff } from './operational';
import { concurrency, failures, getSafety, humanFormPath, rateLimits, representations, restricted } from './robustness';
import { checkpointResume, fork, provenanceHistory, supersession } from './structure';
import { handoff, proposals } from './transfer';

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
  computationEnvelope,
  interSessionHandoff,
];
