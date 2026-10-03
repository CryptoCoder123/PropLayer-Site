// Contract C4 CORS. The origin header is echoed only when it is in ALLOWED_ORIGINS,
// so an unlisted site gets no Access-Control-Allow-Origin at all and the browser
// blocks the response. The desktop app is not subject to CORS.

export const ALLOW_HEADERS = 'authorization, apikey, content-type, x-client-info, x-proplayer-client';
export const ALLOW_METHODS = 'GET, POST, OPTIONS';

export function corsHeaders(request: Request, allowedOrigins: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    Vary: 'Origin'
  };
  const origin = request.headers.get('origin');
  if (origin && allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/** `OPTIONS` → `204` with the CORS headers and no body. */
export function preflight(request: Request, allowedOrigins: readonly string[]): Response | null {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(request, allowedOrigins) });
}
