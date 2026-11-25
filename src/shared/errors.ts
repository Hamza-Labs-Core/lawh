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

export function errorResponse(code: ErrorCode, message: string): Response {
  return Response.json({ code, message }, { status: STATUS[code], headers: { 'Cache-Control': 'no-store' } });
}
