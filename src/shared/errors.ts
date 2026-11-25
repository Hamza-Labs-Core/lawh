export const STATUS = {
  feature_off: 404,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 422,
  too_large: 413,
  secret_found: 422,
  rate_limited: 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof STATUS;

export function errorResponse(code: ErrorCode, message: string, details?: Record<string, unknown>): Response {
  return Response.json({ code, message, ...(details && { details }) }, { status: STATUS[code], headers: { 'Cache-Control': 'no-store' } });
}

/** Thrown by a route to answer with an error. Its message is shown, so it never holds page text or keys. */
export class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
  toResponse(): Response {
    return errorResponse(this.code, this.message, this.details);
  }
}

export const notFound = (): ApiError => new ApiError('not_found', 'Not found.');
export const invalid = (message: string, details?: Record<string, unknown>): ApiError => new ApiError('invalid', message, details);
export const conflict = (message: string, details?: Record<string, unknown>): ApiError => new ApiError('conflict', message, details);
