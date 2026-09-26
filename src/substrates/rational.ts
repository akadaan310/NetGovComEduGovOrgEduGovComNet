/**
 * `exact-rational-calculator`: exact arithmetic over the rationals (BigInt).
 *
 * The same operation names as `deterministic-calculator`, over a different
 * value domain. It exists so that "the same Scroll on a different substrate"
 * is an empirical question rather than an assumption: 0.1 + 0.2 is
 * 0.30000000000000004 on the binary64 calculator and "3/10" here.
 *
 * Inputs: a JSON number is converted through its shortest round-trip decimal
 * representation (String(x)), so 0.1 means 1/10; or a string "p/q" / "p".
 * Outputs: a reduced rational string "p/q", or "p" when the denominator is 1.
 */
import { failure, INVOKED_VIA, PURE, type ApplyResult, type OperationContract, type Substrate, type Value } from './types';

export const MAX_RATIONAL_BITS = 4096;
export const MAX_RATIONAL_EXPONENT = 64;
export const RATIONAL_RE = /^-?\d{1,600}(?:\/\d{1,600})?$/;

interface Q {
  n: bigint;
  d: bigint;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
function norm(n: bigint, d: bigint): Q {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}
const bits = (x: bigint) => abs(x).toString(2).length;
export const formatQ = (q: Q) => (q.d === 1n ? q.n.toString() : `${q.n}/${q.d}`);

function parseDecimal(s: string): Q | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  let n = BigInt(m[2] + frac);
  let d = 10n ** BigInt(frac.length);
  const e = Number(m[4] ?? '0');
  if (e >= 0) n *= 10n ** BigInt(e);
  else d *= 10n ** BigInt(-e);
  return norm(m[1] ? -n : n, d);
}

export function toQ(v: Value): Q | null {
  if (typeof v === 'number') return Number.isFinite(v) ? parseDecimal(String(v)) : null;
  if (typeof v !== 'string' || !RATIONAL_RE.test(v)) return null;
  const [p, q = '1'] = v.split('/');
  const d = BigInt(q);
  if (d === 0n) return null;
  return norm(BigInt(p), d);
}

const RAT = {
  oneOf: [
    { type: 'number', description: 'A finite JSON number, read as its shortest decimal representation (0.1 = 1/10).' },
    { type: 'string', pattern: RATIONAL_RE.source, description: 'An exact rational "p/q" or integer "p".' },
  ],
};
const OUT = { type: 'string', pattern: RATIONAL_RE.source, description: 'Reduced rational "p/q", or "p" when the denominator is 1.' };
const binary = (name: string, description: string, failures: string[] = []): OperationContract => ({
  name,
  description,
  arity: 2,
  input_schema: { type: 'array', prefixItems: [RAT, RAT], minItems: 2, maxItems: 2 },
  output_schema: OUT,
  required_authority: INVOKED_VIA,
  side_effects: PURE,
  determinism: 'deterministic',
  failure_modes: [
    'type_error — an argument is not a finite number or rational string',
    `magnitude_limit — a numerator or denominator would exceed ${MAX_RATIONAL_BITS} bits`,
    ...failures,
  ],
});

const OPERATIONS: OperationContract[] = [
  binary('add', 'a + b, exactly.'),
  binary('subtract', 'a − b, exactly.'),
  binary('multiply', 'a × b, exactly.'),
  binary('divide', 'a ÷ b, exactly.', ['division_by_zero — b is 0']),
  binary('power', `a ^ b for an integer exponent b with |b| ≤ ${MAX_RATIONAL_EXPONENT}, exactly.`, [
    `invalid_exponent — b is not an integer in [-${MAX_RATIONAL_EXPONENT}, ${MAX_RATIONAL_EXPONENT}]`,
    'division_by_zero — a is 0 and b is negative',
  ]),
  binary('modulo', 'a − b·floor(a/b) (floored modulo: the result has the sign of b), exactly.', ['division_by_zero — b is 0']),
];

function floorDiv(n: bigint, d: bigint): bigint {
  // d > 0
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

function apply(op: string, args: Value[]): ApplyResult {
  if (args.length !== 2) return failure('arity_error', `"${op}" takes 2 arguments, got ${args.length}.`);
  const a = toQ(args[0]);
  const b = toQ(args[1]);
  if (!a || !b) return failure('type_error', `"${op}" needs two finite numbers or rational strings; got ${JSON.stringify(args)}.`);
  let r: Q;
  switch (op) {
    case 'add':
      r = norm(a.n * b.d + b.n * a.d, a.d * b.d);
      break;
    case 'subtract':
      r = norm(a.n * b.d - b.n * a.d, a.d * b.d);
      break;
    case 'multiply':
      r = norm(a.n * b.n, a.d * b.d);
      break;
    case 'divide':
      if (b.n === 0n) return failure('division_by_zero', 'Division by zero.');
      r = norm(a.n * b.d, a.d * b.n);
      break;
    case 'power': {
      if (b.d !== 1n || abs(b.n) > BigInt(MAX_RATIONAL_EXPONENT)) {
        return failure('invalid_exponent', `The exponent must be an integer in [-${MAX_RATIONAL_EXPONENT}, ${MAX_RATIONAL_EXPONENT}].`);
      }
      if (a.n === 0n && b.n < 0n) return failure('division_by_zero', '0 raised to a negative power.');
      const e = abs(b.n);
      // Check the size before computing: bits(x^e) <= e * bits(x).
      if (Number(e) * Math.max(bits(a.n), bits(a.d)) > MAX_RATIONAL_BITS) {
        return failure('magnitude_limit', `The result would exceed ${MAX_RATIONAL_BITS} bits.`);
      }
      r = b.n < 0n ? norm(a.d ** e, a.n ** e) : norm(a.n ** e, a.d ** e);
      break;
    }
    case 'modulo': {
      if (b.n === 0n) return failure('division_by_zero', 'Modulo by zero.');
      // a/b = (a.n*b.d)/(a.d*b.n); floor it with a positive denominator.
      const num = a.n * b.d;
      const den = a.d * b.n;
      const f = den < 0n ? floorDiv(-num, -den) : floorDiv(num, den);
      r = norm(a.n * b.d - f * b.n * a.d, a.d * b.d);
      break;
    }
    default:
      return failure('unknown_operation', `exact-rational-calculator has no operation "${op}".`);
  }
  if (bits(r.n) > MAX_RATIONAL_BITS || bits(r.d) > MAX_RATIONAL_BITS) {
    return failure('magnitude_limit', `The result exceeds ${MAX_RATIONAL_BITS} bits.`);
  }
  return { ok: true, value: formatQ(r) };
}

export const exactRationalCalculator: Substrate = {
  manifest: {
    substrate_id: 'exact-rational-calculator',
    kind: 'calculator',
    provider: 'acsp-local',
    version: '1.0',
    status: 'available',
    execution_mode: 'in-process-pure',
    description:
      'Exact rational arithmetic (arbitrary-precision integers) over the same closed operation set as deterministic-calculator. ' +
      'Deterministic and replayable. Evaluates no code.',
    value_domain: 'rationals; inputs are JSON numbers (read as decimals) or "p/q" strings; results are reduced "p/q" strings',
    capabilities: OPERATIONS.map((o) => o.name),
    operations: OPERATIONS,
    surface: { protocol: 'acsp-local', purl_manifest: null },
    provenance: { implementation: 'src/substrates/rational.ts', introduced_by: 'ACSP Program 001' },
  },
  apply,
};
