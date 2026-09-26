/** Protocol errors: a stable machine code, an HTTP status and a human message. */
export type ErrorCode =
  | 'malformed_request'
  | 'unsupported_protocol'
  | 'unknown_operation'
  | 'missing_expected_version'
  | 'invalid_capability'
  | 'capability_expired'
  | 'capability_revoked'
  | 'authentication_required'
  | 'capability_resource_mismatch'
  | 'session_mismatch'
  | 'insufficient_authority'
  | 'invalid_create_key'
  | 'proposals_closed'
  | 'not_found'
  | 'stale_version'
  | 'resource_closed'
  | 'invalid_state'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'invalid_payload'
  | 'idempotency_key_reuse'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'not_embodied'
  | 'substrate_unavailable'
  | 'method_not_allowed'
  | 'service_unavailable'
  | 'internal_error';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  malformed_request: 400,
  unsupported_protocol: 400,
  unknown_operation: 400,
  missing_expected_version: 400,
  invalid_capability: 401,
  capability_expired: 401,
  capability_revoked: 401,
  authentication_required: 401,
  capability_resource_mismatch: 403,
  session_mismatch: 403,
  insufficient_authority: 403,
  invalid_create_key: 403,
  proposals_closed: 403,
  not_embodied: 403,
  not_found: 404,
  method_not_allowed: 405,
  stale_version: 409,
  resource_closed: 409,
  invalid_state: 409,
  substrate_unavailable: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_payload: 422,
  idempotency_key_reuse: 422,
  limit_exceeded: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
};

export class AcspError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new AcspError(code, message, details);
};
