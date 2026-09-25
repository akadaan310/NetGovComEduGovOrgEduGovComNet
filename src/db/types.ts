/**
 * Minimal database interface. Both implementations (node-postgres and PGlite)
 * speak PostgreSQL, so the continuity layer writes plain SQL once.
 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Execute a multi-statement script without parameters (migrations). */
  exec(text: string): Promise<void>;
}

export interface Database extends Sql {
  /** Run `fn` inside a single transaction (READ COMMITTED). Rolls back on throw. */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'pglite';
}

/** Postgres error code for unique violations. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null;
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return e.constraint === constraint || (e.message ?? '').includes(constraint);
}
