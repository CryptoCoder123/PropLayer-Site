// In-handler bearer-token validation. Contract C4 sets verify_jwt = false on all four
// functions so behaviour is identical with legacy anon JWTs and newer publishable keys;
// this check is therefore the only thing standing between a caller and another user's data.

import { HttpError } from './http.ts';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
}

export interface Auth {
  /** Resolves the token's user, or throws `401 unauthorized`. */
  getUser(token: string): Promise<AuthUser>;
}

/** Reads `Authorization: Bearer <token>`; throws `401 unauthorized` when absent or malformed. */
export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new HttpError(401, 'unauthorized');
  return match[1];
}

export async function requireUser(request: Request, auth: Auth): Promise<AuthUser> {
  return await auth.getUser(bearerToken(request));
}

/**
 * Real implementation, backed by the service-role Supabase client's `auth.getUser(token)`.
 * `client` is passed in rather than constructed here so tests never need the network.
 */
export function createAuth(client: {
  auth: { getUser(token: string): Promise<{ data: { user: unknown }; error: unknown }> };
}): Auth {
  return {
    async getUser(token: string): Promise<AuthUser> {
      if (!token) throw new HttpError(401, 'unauthorized');
      let result;
      try {
        result = await client.auth.getUser(token);
      } catch {
        // A transport failure talking to Auth is not the caller's fault.
        throw new HttpError(500, 'internal');
      }
      const user = result?.data?.user as { id?: string; email?: string } | null | undefined;
      if (result?.error || !user?.id) throw new HttpError(401, 'unauthorized');
      return Object.freeze({ id: user.id, email: user.email ?? '' });
    }
  };
}
