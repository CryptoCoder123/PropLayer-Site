// Response helpers. Every body is JSON and no answer is ever cached (contract C4).

export const ERROR_CODES = [
  'unauthorized',
  'method_not_allowed',
  'already_subscribed',
  'no_customer',
  'bad_signature',
  'stripe_error',
  'not_configured',
  'internal'
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

/** The human-readable half of the contract error envelope. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  unauthorized: 'Sign in again.',
  method_not_allowed: 'This endpoint does not accept that method.',
  already_subscribed: 'You already have an active subscription. Use Manage billing.',
  no_customer: 'No billing account exists for this user yet.',
  bad_signature: 'Invalid signature.',
  stripe_error: 'The payment provider is unavailable. Try again shortly.',
  not_configured: 'The account service is not configured yet.',
  internal: 'Something went wrong. Try again.'
};

export function json(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...Object.fromEntries(new Headers(extraHeaders))
    }
  });
}

/** Contract C4 error envelope: `{"error":"<code>","message":"<human readable>"}`. */
export function error(status: number, code: ErrorCode, message?: string, extraHeaders: HeadersInit = {}): Response {
  return json(status, { error: code, message: message ?? ERROR_MESSAGES[code] }, extraHeaders);
}

/** Thrown inside handlers to produce a contract error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message?: string
  ) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'HttpError';
  }

  toResponse(extraHeaders: HeadersInit = {}): Response {
    return error(this.status, this.code, this.message, extraHeaders);
  }
}

/**
 * A short, safe description of a failure for logs: the error's name, message and Stripe
 * request id when present. Never a request body, a token or a secret.
 */
export function describeError(thrown: unknown): string {
  if (thrown instanceof Error) {
    const requestId = (thrown as { requestId?: string }).requestId;
    return requestId
      ? `${thrown.name}: ${thrown.message} (stripe request ${requestId})`
      : `${thrown.name}: ${thrown.message}`;
  }
  return String(thrown);
}
