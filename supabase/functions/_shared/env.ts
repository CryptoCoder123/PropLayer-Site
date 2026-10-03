// Secrets and tuneable settings for the Prop Layer account functions (guide 5.2).
// Nothing here is ever logged or returned to a caller.

export const STRIPE_VERSION = '18.5.0';
export const SUPABASE_JS_VERSION = '2.117.2';

export interface Config {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly stripeSecretKey: string;
  readonly stripeWebhookSecret: string;
  readonly priceLookupKey: string;
  readonly portalConfigurationId: string;
  readonly automaticTax: boolean;
  readonly siteUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly recheckAfterSeconds: number;
  readonly offlineGraceSeconds: number;
  readonly pastDueEntitled: boolean;
}

export type EnvSource = Record<string, string | undefined>;

/** Contract C5 ranges. Values outside them are clamped rather than rejected. */
export const RECHECK_MIN = 300;
export const RECHECK_MAX = 86_400;
export const GRACE_MIN = 0;
export const GRACE_MAX = 604_800;

export const DEFAULT_SITE_URL = 'https://prop-layer.com';
export const DEFAULT_ALLOWED_ORIGINS = 'https://prop-layer.com,http://localhost:4173';
export const DEFAULT_PRICE_LOOKUP_KEY = 'proplayer_monthly';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function intOr(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return clamp(Number.isFinite(parsed) ? parsed : fallback, min, max);
}

/** `true`/`1`/`yes` (any case) are true; anything else, including empty, is false. */
function boolOr(raw: string | undefined, fallback: boolean): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Service-role database access: `SUPABASE_SERVICE_ROLE_KEY` when the platform provides it,
 * otherwise the `default` entry of the newer `SUPABASE_SECRET_KEYS` JSON. Returns '' when
 * neither exists, which makes `isConfigured` false and every endpoint answer 503.
 */
export function readServiceRoleKey(source: EnvSource): string {
  const direct = (source.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (direct) return direct;

  const raw = (source.SUPABASE_SECRET_KEYS ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed.trim();
    if (Array.isArray(parsed)) {
      const named = parsed.find(entry => entry && entry.name === 'default');
      return String(named?.api_key ?? named?.key ?? parsed[0]?.api_key ?? parsed[0]?.key ?? '').trim();
    }
    if (parsed && typeof parsed === 'object') {
      const entry = parsed.default ?? parsed.secret ?? '';
      if (typeof entry === 'string') return entry.trim();
      return String(entry?.api_key ?? entry?.key ?? '').trim();
    }
  } catch {
    // A malformed secret is treated as absent: fail closed with 503, never crash.
  }
  return '';
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function readConfig(source: EnvSource): Config {
  return Object.freeze({
    supabaseUrl: trimTrailingSlash((source.SUPABASE_URL ?? '').trim()),
    serviceRoleKey: readServiceRoleKey(source),
    stripeSecretKey: (source.STRIPE_SECRET_KEY ?? '').trim(),
    stripeWebhookSecret: (source.STRIPE_WEBHOOK_SECRET ?? '').trim(),
    priceLookupKey: (source.STRIPE_PRICE_LOOKUP_KEY ?? '').trim() || DEFAULT_PRICE_LOOKUP_KEY,
    portalConfigurationId: (source.STRIPE_PORTAL_CONFIGURATION_ID ?? '').trim(),
    automaticTax: boolOr(source.STRIPE_AUTOMATIC_TAX, false),
    siteUrl: trimTrailingSlash((source.SITE_URL ?? '').trim() || DEFAULT_SITE_URL),
    allowedOrigins: Object.freeze(
      (source.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
        .split(',')
        .map(origin => trimTrailingSlash(origin.trim()))
        .filter(Boolean)
    ),
    recheckAfterSeconds: intOr(source.ENTITLEMENT_RECHECK_SECONDS, 3600, RECHECK_MIN, RECHECK_MAX),
    offlineGraceSeconds: intOr(source.OFFLINE_GRACE_SECONDS, 259_200, GRACE_MIN, GRACE_MAX),
    pastDueEntitled: boolOr(source.PAST_DUE_ENTITLED, true)
  });
}

/** Everything the user-facing endpoints need. Missing pieces mean `503 not_configured`. */
export function isConfigured(config: Config): boolean {
  return Boolean(config.supabaseUrl && config.serviceRoleKey && config.stripeSecretKey);
}

/** The webhook does not need a user token, but it does need its signing secret. */
export function isWebhookConfigured(config: Config): boolean {
  return Boolean(config.supabaseUrl && config.serviceRoleKey && config.stripeSecretKey && config.stripeWebhookSecret);
}
