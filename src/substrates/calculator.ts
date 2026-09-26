/**
 * `deterministic-calculator`: IEEE-754 binary64 arithmetic.
 *
 * Deterministic across conforming engines: add, subtract, multiply, divide
 * and remainder are correctly rounded (or exact) by IEEE-754, and `power` is
 * restricted to integer exponents computed by a fixed square-and-multiply
 * sequence instead of `Math.pow` (whose last-bit results are not specified).
 * No code is evaluated; operations are a closed set.
 */
import { failure, INVOKED_VIA, PURE, type ApplyResult, type OperationContract, type Substrate, type Value } from './types';

const NUM = { type: 'number', description: 'A finite IEEE-754 binary64 value (JSON number).' };
const binary = (name: string, description: string, failures: string[] = []): OperationContract => ({
  name,
  description,
  arity: 2,
  input_schema: { type: 'array', prefixItems: [NUM, NUM], minItems: 2, maxItems: 2 },
  output_schema: NUM,
  required_authority: INVOKED_VIA,
  side_effects: PURE,
  determinism: 'deterministic',
  failure_modes: ['type_error — an argument is not a finite number', 'non_finite_result — the result overflowed', ...failures],
});

export const MAX_FLOAT_EXPONENT = 1024;

const OPERATIONS: OperationContract[] = [
  binary('add', 'a + b, rounded to binary64.'),
  binary('subtract', 'a − b, rounded to binary64.'),
  binary('multiply', 'a × b, rounded to binary64.'),
  binary('divide', 'a ÷ b, rounded to binary64.', ['division_by_zero — b is 0']),
  {
    ...binary('power', `a ^ b for an integer exponent b with |b| ≤ ${MAX_FLOAT_EXPONENT}, by square-and-multiply (not Math.pow).`, [
      `invalid_exponent — b is not an integer in [-${MAX_FLOAT_EXPONENT}, ${MAX_FLOAT_EXPONENT}]`,
      'division_by_zero — a is 0 and b is negative',
    ]),
    input_schema: { type: 'array', prefixItems: [NUM, { type: 'integer', minimum: -MAX_FLOAT_EXPONENT, maximum: MAX_FLOAT_EXPONENT }], minItems: 2, maxItems: 2 },
  },
  binary('modulo', 'IEEE remainder with the sign of a (JavaScript %, C fmod). Exact.', ['division_by_zero — b is 0']),
];

function powInt(base: number, exp: number): number {
  let result = 1;
  let b = base;
  let e = Math.abs(exp);
  while (e > 0) {
    if (e & 1) result *= b;
    b *= b;
    e >>>= 1;
  }
  return exp < 0 ? 1 / result : result;
}

function apply(op: string, args: Value[]): ApplyResult {
  if (args.length !== 2) return failure('arity_error', `"${op}" takes 2 arguments, got ${args.length}.`);
  const [a, b] = args;
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return failure('type_error', `"${op}" needs two finite numbers; got ${JSON.stringify(args)}.`);
  }
  let r: number;
  switch (op) {
    case 'add':
      r = a + b;
      break;
    case 'subtract':
      r = a - b;
      break;
    case 'multiply':
      r = a * b;
      break;
    case 'divide':
      if (b === 0) return failure('division_by_zero', 'Division by zero.');
      r = a / b;
      break;
    case 'power':
      if (!Number.isInteger(b) || Math.abs(b) > MAX_FLOAT_EXPONENT) {
        return failure('invalid_exponent', `The exponent must be an integer in [-${MAX_FLOAT_EXPONENT}, ${MAX_FLOAT_EXPONENT}].`);
      }
      if (a === 0 && b < 0) return failure('division_by_zero', '0 raised to a negative power.');
      r = powInt(a, b);
      break;
    case 'modulo':
      if (b === 0) return failure('division_by_zero', 'Modulo by zero.');
      r = a % b;
      break;
    default:
      return failure('unknown_operation', `deterministic-calculator has no operation "${op}".`);
  }
  if (!Number.isFinite(r)) return failure('non_finite_result', `"${op}" produced a non-finite result.`);
  // Normalise -0 so results serialise identically ("0").
  return { ok: true, value: Object.is(r, -0) ? 0 : r };
}

export const deterministicCalculator: Substrate = {
  manifest: {
    substrate_id: 'deterministic-calculator',
    kind: 'calculator',
    provider: 'acsp-local',
    version: '1.0',
    status: 'available',
    execution_mode: 'in-process-pure',
    description: 'IEEE-754 binary64 arithmetic over a closed operation set. Deterministic and replayable. Evaluates no code.',
    value_domain: 'finite binary64 numbers (JSON numbers); results are JSON numbers',
    capabilities: OPERATIONS.map((o) => o.name),
    operations: OPERATIONS,
    surface: { protocol: 'acsp-local', purl_manifest: null },
    provenance: { implementation: 'src/substrates/calculator.ts', introduced_by: 'ACSP Program 001' },
  },
  apply,
};
