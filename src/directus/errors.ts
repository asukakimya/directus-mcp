/**
 * Standardised error types used across the MCP sidecar.
 *
 * Each `McpUserError` carries an `errorCode` (one of the codes listed in
 * the spec, section 14) and a serialisable `details` payload. The MCP
 * tool layer converts these into the wire format documented in §14.
 */

export type ErrorCode =
  | 'CONFIG_ERROR'
  | 'DIRECTUS_API_ERROR'
  | 'COLLECTION_NOT_ALLOWED'
  | 'SYSTEM_COLLECTION_DENIED'
  | 'SCHEMA_NOT_FOUND'
  | 'PRIMARY_KEY_NOT_FOUND'
  | 'UNKNOWN_FIELD'
  | 'READONLY_FIELD'
  | 'PRIMARY_KEY_UPDATE_DENIED'
  | 'REQUIRED_FIELD_MISSING'
  | 'INVALID_QUERY'
  | 'INVALID_FILTER_OPERATOR'
  | 'VERIFY_FAILED'
  | 'DUPLICATE_FOUND'
  | 'BATCH_LIMIT_EXCEEDED'
  | 'DELETE_DISABLED'
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_JSON'
  | 'INVALID_DATA_TYPE'
  | 'DRY_RUN_REQUIRED'
  | 'VERIFY_REQUIRED'
  | 'ABORTED_BY_PREFLIGHT'
  | 'NOT_FOUND'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_EXPIRED'
  | 'PLAN_ALREADY_APPLIED'
  | 'PLAN_ALREADY_IN_PROGRESS'
  | 'PLAN_CANCELLED'
  | 'PLAN_CHECKSUM_MISMATCH'
  | 'APPLY_REQUIRES_PLAN'
  | 'PLAN_STORE_ERROR'
  | 'PLAN_TOO_LARGE'
  | 'READBACK_MISMATCH'
  | 'CONFIRM_TRUE_REQUIRED';

export interface ErrorDetails {
  [key: string]: unknown;
}

export class McpUserError extends Error {
  readonly errorCode: ErrorCode;
  readonly details: ErrorDetails;

  constructor(errorCode: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'McpUserError';
    this.errorCode = errorCode;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details: ErrorDetails } {
    return {
      code: this.errorCode,
      message: this.message,
      details: this.details,
    };
  }
}
