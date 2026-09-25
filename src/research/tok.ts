/**
 * RESEARCH LAYER — Transfer of Knowledge (TOK) records and annotations.
 *
 * A TOK is an explicit research artifact that a session decided to publish.
 * It is not memory, and the substrate never judges whether it is true.
 * This module knows nothing about versions, authority or HTTP.
 */
import { z } from 'zod';

export const TOK_TYPES = [
  'observation',
  'finding',
  'hypothesis',
  'question',
  'constraint',
  'decision',
  'rejection',
  'uncertainty',
  'reference',
  'task',
  'delegation',
  'closure',
] as const;
export type TokType = (typeof TOK_TYPES)[number];

export const TOK_TYPE_MEANINGS: Record<TokType, string> = {
  observation: 'Something that was observed or measured, stated without interpretation.',
  finding: 'A result the source considers established by its own work.',
  hypothesis: 'A proposed explanation that has not been established.',
  question: 'An open question that should be investigated.',
  constraint: 'A limitation, requirement or boundary condition on the research.',
  decision: 'A choice that was made, and ideally why.',
  rejection: 'An idea, path or hypothesis that was considered and rejected.',
  uncertainty: 'A known unknown, or a point of low confidence worth flagging.',
  reference: 'A pointer to an external source (paper, dataset, URL, code).',
  task: 'A unit of work. It has a responsible session, and responsibility moves only through handoff + acknowledge.',
  delegation:
    'A research note describing a division of labour. It grants NO authority; authority comes only from the `delegate` operation.',
  closure: 'A statement that a line of inquiry is finished, and with what outcome.',
};

export const CONFIDENCE_LEVELS = ['unclassified', 'low', 'medium', 'high'] as const;
export type StatedConfidence = (typeof CONFIDENCE_LEVELS)[number];

export const TOK_STATUSES = ['active', 'superseded'] as const;
export type TokStatus = (typeof TOK_STATUSES)[number];

export const ANNOTATION_KINDS = ['comment', 'endorsement', 'dispute', 'correction', 'validation'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const LIMITS = {
  title: 200,
  summary: 2_000,
  content: 20_000,
  refs: 20,
  annotation: 10_000,
} as const;

const httpUrl = z
  .string()
  .max(2_000)
  .refine((u) => {
    try {
      const p = new URL(u).protocol;
      return p === 'https:' || p === 'http:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

export const TokIdSchema = z.string().regex(/^TOK-\d{3,}$/, 'must look like TOK-001');

export const RefSchema = z.union([
  z.strictObject({ tok: TokIdSchema, note: z.string().max(500).optional() }),
  z.strictObject({ url: httpUrl, note: z.string().max(500).optional() }),
  z.strictObject({ citation: z.string().min(1).max(1_000) }),
]);
export type Ref = z.infer<typeof RefSchema>;

/** The content a session supplies for a new TOK (append, supersede replacement, proposals). */
export const TokInputSchema = z.strictObject({
  type: z.enum(TOK_TYPES),
  title: z.string().trim().min(1).max(LIMITS.title),
  summary: z.string().max(LIMITS.summary).default(''),
  content: z.string().max(LIMITS.content).default(''),
  stated_confidence: z.enum(CONFIDENCE_LEVELS).default('unclassified'),
  refs: z.array(RefSchema).max(LIMITS.refs).default([]),
});
export type TokInput = z.infer<typeof TokInputSchema>;

export const EvidenceSchema = z.strictObject({
  method: z.string().min(1).max(500),
  reference: z.string().max(2_000).optional(),
  result: z.string().min(1).max(2_000),
});

export const AnnotationInputSchema = z
  .strictObject({
    tok_id: TokIdSchema,
    kind: z.enum(ANNOTATION_KINDS),
    content: z.string().trim().min(1).max(LIMITS.annotation),
    evidence: EvidenceSchema.optional(),
  })
  .refine((a) => a.kind !== 'validation' || a.evidence !== undefined, {
    message: 'validation annotations must include evidence { method, result }',
    path: ['evidence'],
  });
export type AnnotationInput = z.infer<typeof AnnotationInputSchema>;

/** Statement published with every knowledge listing. */
export const KNOWLEDGE_SEMANTICS =
  'Each TOK is an externally persisted research artifact, stored exactly as its source published it. ' +
  'ACSP does not evaluate truth: stated_confidence is the source\'s own claim, and a "validation" annotation ' +
  'is a claim by its annotator that an external check was made. The receiving session decides what meaning to assign.';

export function formatTokId(n: number): string {
  return `TOK-${String(n).padStart(3, '0')}`;
}
