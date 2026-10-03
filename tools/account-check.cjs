/* Account and download browser suite (guide 7.3).

   Every backend call is mocked with context.route: Supabase Auth, the Edge Functions, the
   GitHub releases API and the Stripe Checkout/Portal URLs the page redirects to. Nothing in
   this file touches a real service, and assets/config.js is routed to a configured copy so
   the page under test believes accounts are switched on.

   Same harness style as browser-check.cjs: Playwright, installed Chrome, `npm run dev`
   running on port 4173, reduced motion.
*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const BASE = 'http://127.0.0.1:4173';
const SUPABASE_URL = 'https://project.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_test_key';
const USER_ID = '3f6c2a1e-8b4d-4c1a-9e2f-5a7b9c0d1e2f';
const EMAIL = 'fan@example.com';
const PRICE_DISPLAY = '$14.99 / month';
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_123';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_123';
const RELEASES_REPO = 'CryptoCoder123/PropLayer-Releases';

// Playwright's installed-Chrome channel by default; PLAYWRIGHT_CHANNEL=chromium runs the
// bundled build instead, for machines without Google Chrome.
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';

const TEST_CONFIG = `window.PROPLAYER_CONFIG = Object.freeze({
  supabaseUrl: '${SUPABASE_URL}',
  supabasePublishableKey: '${PUBLISHABLE_KEY}',
  siteUrl: '${BASE}',
  releasesRepo: '${RELEASES_REPO}',
  planName: 'Prop Layer Monthly',
  priceDisplay: '${PRICE_DISPLAY}'
});`;

const UNCONFIGURED_CONFIG = `window.PROPLAYER_CONFIG = Object.freeze({
  supabaseUrl: '__SET_ME__',
  supabasePublishableKey: '__SET_ME__',
  siteUrl: 'https://prop-layer.com',
  releasesRepo: '${RELEASES_REPO}',
  planName: 'Prop Layer Monthly',
  priceDisplay: '__SET_ME__'
});`;

// ---------------------------------------------------------------- fixtures
const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A syntactically valid but unsigned JWT: the mocked backend never verifies it. */
function jwt({ sub = USER_ID, email = EMAIL, lifetimeSeconds = 3600 } = {}) {
  const issued = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({ sub, email, aud: 'authenticated', role: 'authenticated', iat: issued, exp: issued + lifetimeSeconds }),
    'unsigned-test-signature'
  ].join('.');
}

function userObject(email = EMAIL) {
  const now = new Date().toISOString();
  return {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: now,
    confirmed_at: now,
    last_sign_in_at: now,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: now,
    updated_at: now
  };
}

function sessionObject({ refreshToken = 'refresh-token-1', lifetimeSeconds = 3600 } = {}) {
  return {
    access_token: jwt({ lifetimeSeconds }),
    token_type: 'bearer',
    expires_in: lifetimeSeconds,
    expires_at: Math.floor(Date.now() / 1000) + lifetimeSeconds,
    refresh_token: refreshToken,
    user: userObject()
  };
}

const LINKS = {
  account: 'https://prop-layer.com/account.html',
  subscribe: 'https://prop-layer.com/account.html#subscribe',
  manage: 'https://prop-layer.com/account.html#billing',
  download: 'https://prop-layer.com/download.html'
};

function entitlement(reason, overrides = {}) {
  const entitled = ['active', 'trialing', 'canceled_pending', 'past_due_grace'].includes(reason);
  const statusFor = {
    active: 'active', trialing: 'trialing', canceled_pending: 'active', past_due_grace: 'past_due',
    payment_failed: 'unpaid', expired: 'canceled', incomplete: 'incomplete'
  };
  const periodEnd = '2026-11-03T16:00:00Z';
  return {
    schema: 1,
    user: { id: USER_ID, email: EMAIL },
    entitled,
    reason,
    subscription: reason === 'no_subscription' ? null : {
      status: statusFor[reason] ?? 'active',
      plan: 'proplayer_monthly',
      current_period_end: periodEnd,
      cancel_at_period_end: reason === 'canceled_pending',
      access_until: entitled ? periodEnd : null
    },
    checked_at: '2026-10-03T16:00:00Z',
    recheck_after_seconds: 3600,
    offline_grace_seconds: 259200,
    links: LINKS,
    ...overrides
  };
}

const RELEASE = {
  tag_name: 'v0.1.0',
  published_at: '2026-10-01T12:00:00Z',
  body: '## Prop Layer 0.1.0\n\nFirst public build.\n\n- Basketball, football, baseball and hockey\n- **FFmpeg** is included under the LGPL; the corresponding source is attached as `PropLayer-ffmpeg-source-electron-v38.2.2-win32-x64.zip`.\n- Full notice: https://prop-layer.com/terms.html\n',
  assets: [
    {
      name: 'PropLayer-Setup-0.1.0.exe',
      size: 122_683_392,
      digest: 'sha256:9f2c4a1e8b4d4c1a9e2f5a7b9c0d1e2f3a4b5c6d7e8f90123456789abcdef012',
      browser_download_url: `https://github.com/${RELEASES_REPO}/releases/download/v0.1.0/PropLayer-Setup-0.1.0.exe`
    },
    {
      name: 'PropLayer-ffmpeg-source-electron-v38.2.2-win32-x64.zip',
      size: 31_457_280,
      browser_download_url: `https://github.com/${RELEASES_REPO}/releases/download/v0.1.0/PropLayer-ffmpeg-source-electron-v38.2.2-win32-x64.zip`
    },
    {
      name: 'SHA256SUMS.txt',
      size: 240,
      browser_download_url: `https://github.com/${RELEASES_REPO}/releases/download/v0.1.0/SHA256SUMS.txt`
    }
  ]
};

// ---------------------------------------------------------------- the mocked backend
function createBackend() {
  return {
    // what the mocked endpoints answer with
    entitlementQueue: [],
    entitlement: entitlement('no_subscription'),
    entitlementStatus: 200,
    checkout: { status: 200, body: { url: CHECKOUT_URL } },
    portal: { status: 200, body: { url: PORTAL_URL } },
    signIn: { status: 200 },
    signUp: { status: 200 },
    recover: { status: 200 },
    resend: { status: 200 },
    refresh: { status: 200 },
    // what actually happened
    authRequests: [],
    functionRequests: [],
    offsiteRequests: []
  };
}

const CORS = origin => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-proplayer-client',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin'
});

function jsonResponse(route, status, body, origin) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...CORS(origin), 'Cache-Control': 'no-store' },
    body: JSON.stringify(body ?? {})
  });
}

async function installMocks(context, backend, { config = TEST_CONFIG } = {}) {
  // The page believes accounts are configured (or not, for the unconfigured scenario).
  await context.route('**/assets/config.js', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: config })
  );
  await context.route('**/googletagmanager.com/**', route => route.fulfill({ status: 200, body: '' }));
  await context.route('**/google-analytics.com/**', route => route.fulfill({ status: 204, body: '' }));

  // ---- Supabase Auth
  await context.route(`${SUPABASE_URL}/auth/v1/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const origin = request.headers().origin ?? BASE;

    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS(origin), body: '' });
    }

    const path = url.pathname.replace('/auth/v1/', '');
    const grant = url.searchParams.get('grant_type');
    let payload = null;
    try { payload = request.postDataJSON(); } catch { payload = null; }
    backend.authRequests.push({ path, grant, method: request.method() });

    if (path === 'token' && grant === 'password') {
      const outcome = backend.signIn;
      if (outcome.status !== 200) return jsonResponse(route, outcome.status, outcome.body, origin);
      return jsonResponse(route, 200, sessionObject(), origin);
    }
    if (path === 'token' && grant === 'refresh_token') {
      const outcome = backend.refresh;
      if (outcome.status !== 200) return jsonResponse(route, outcome.status, outcome.body, origin);
      return jsonResponse(route, 200, sessionObject({ refreshToken: 'refresh-token-2' }), origin);
    }
    if (path === 'signup') {
      const outcome = backend.signUp;
      if (outcome.status !== 200) return jsonResponse(route, outcome.status, outcome.body, origin);
      // Confirmation required: a user with no session comes back.
      return jsonResponse(route, 200, { ...userObject(payload?.email ?? EMAIL), email_confirmed_at: null }, origin);
    }
    if (path === 'recover') {
      const outcome = backend.recover;
      return jsonResponse(route, outcome.status, outcome.body ?? {}, origin);
    }
    if (path === 'resend') {
      const outcome = backend.resend;
      return jsonResponse(route, outcome.status, outcome.body ?? {}, origin);
    }
    if (path === 'user') {
      if (request.method() === 'PUT') return jsonResponse(route, 200, userObject(), origin);
      return jsonResponse(route, 200, userObject(), origin);
    }
    if (path === 'logout') {
      return route.fulfill({ status: 204, headers: CORS(origin), body: '' });
    }
    return jsonResponse(route, 200, {}, origin);
  });

  // ---- Edge Functions
  await context.route(`${SUPABASE_URL}/functions/v1/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const origin = request.headers().origin ?? BASE;
    const name = url.pathname.replace('/functions/v1/', '');

    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS(origin), body: '' });
    }

    backend.functionRequests.push({ name, method: request.method() });

    if (name === 'entitlement') {
      const queued = backend.entitlementQueue.shift();
      const answer = queued ?? { status: backend.entitlementStatus, body: backend.entitlement };
      if (answer.status === 0) return route.abort('failed');
      return jsonResponse(route, answer.status, answer.body, origin);
    }
    if (name === 'create-checkout-session') {
      return jsonResponse(route, backend.checkout.status, backend.checkout.body, origin);
    }
    if (name === 'create-portal-session') {
      return jsonResponse(route, backend.portal.status, backend.portal.body, origin);
    }
    return jsonResponse(route, 404, { error: 'internal', message: 'unknown function' }, origin);
  });

  // ---- GitHub releases
  await context.route('https://api.github.com/**', route => {
    const answer = backend.release ?? { status: 200, body: RELEASE };
    backend.offsiteRequests.push('github');
    if (answer.status === 0) return route.abort('failed');
    return route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: JSON.stringify(answer.body ?? {})
    });
  });

  // ---- The Stripe pages the site redirects to. A tiny HTML page lets the test assert the
  //      redirect actually happened rather than guessing from a pending request.
  for (const pattern of ['https://checkout.stripe.com/**', 'https://billing.stripe.com/**']) {
    await context.route(pattern, route => {
      backend.offsiteRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Stripe test stand-in</title><h1 id="stripe-stub">Stripe</h1>'
      });
    });
  }
}

// ---------------------------------------------------------------- harness
(async () => {
  fs.mkdirSync('artifacts', { recursive: true });
  const browser = await chromium.launch({ channel: CHANNEL, headless: true });
  const checks = [];
  const failures = [];

  async function check(name, fn) {
    const backend = createBackend();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const pageErrors = [];
    try {
      await installMocks(context, backend);
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      await fn({ page, context, backend, pageErrors });
      assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('; ')}`);
      checks.push(name);
      console.log('PASS', name);
    } catch (error) {
      failures.push({ name, error });
      console.error('FAIL', name);
      console.error('    ', error.message.split('\n').slice(0, 6).join('\n     '));
    } finally {
      await context.close();
    }
  }

  const visible = (page, id) => page.locator(`#${id}`).isVisible();
  const text = (page, id) => page.locator(`#${id}`).textContent();

  async function signIn(page, { email = EMAIL, password = 'correct-horse-battery' } = {}) {
    await page.locator('#signin-email').fill(email);
    await page.locator('#signin-password').fill(password);
    await page.locator('#signin-submit').click();
  }

  // ---------------------------------------------------------------- not configured
  await check('An unconfigured site shows "opening soon" and makes zero backend calls', async ({ context, backend }) => {
    await context.unroute('**/assets/config.js');
    await context.route('**/assets/config.js', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: UNCONFIGURED_CONFIG })
    );
    const page = await context.newPage();
    const blocked = [];
    page.on('request', request => {
      if (/supabase\.co|checkout\.stripe|billing\.stripe/.test(request.url())) blocked.push(request.url());
    });
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });

    assert.equal(await visible(page, 'view-unconfigured'), true);
    assert.equal(await visible(page, 'view-signin'), false);
    assert.match(await text(page, 'unconfigured-heading'), /opening soon/i);
    assert.deepEqual(blocked, [], 'the unconfigured view must not call the backend');
    assert.deepEqual(backend.authRequests, []);
    assert.deepEqual(backend.functionRequests, []);
    // The download link still works for an unconfigured site.
    assert.equal(await page.locator('#view-unconfigured a[href="download.html"]').count(), 1);
  });

  // ---------------------------------------------------------------- signed out
  await check('The default signed-out view is sign in, with labelled fields', async ({ page }) => {
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    assert.equal(await visible(page, 'view-signin'), true);
    for (const [input, autocomplete] of [['signin-email', 'email'], ['signin-password', 'current-password']]) {
      assert.equal(await page.locator(`#${input}`).getAttribute('autocomplete'), autocomplete);
      assert.equal(await page.locator(`label[for="${input}"]`).count(), 1, `${input} needs a label`);
    }
    assert.equal(await page.locator('#signin-email').getAttribute('type'), 'email');
  });

  await check('Create account shows "check your inbox" and never says whether the email exists', async ({ page, backend }) => {
    await page.goto(`${BASE}/account.html#signup`, { waitUntil: 'networkidle' });
    assert.equal(await visible(page, 'view-signup'), true);

    await page.locator('#signup-email').fill(EMAIL);
    await page.locator('#signup-password').fill('correct-horse-battery');
    await page.locator('#signup-confirm').fill('correct-horse-battery');
    await page.locator('#signup-submit').click();

    await page.locator('#account-status[data-state=success]').waitFor();
    assert.match(await text(page, 'account-status'), /check your inbox/i);
    assert.equal(await visible(page, 'view-signin'), true, 'the visitor lands on sign in afterwards');
    assert.ok(backend.authRequests.some(r => r.path === 'signup'));
    const status = await text(page, 'account-status');
    assert.doesNotMatch(status, /already|exists|taken/i);
  });

  await check('Sign-up rejects a short password and a mismatch without calling the backend', async ({ page, backend }) => {
    await page.goto(`${BASE}/account.html#signup`, { waitUntil: 'networkidle' });

    await page.locator('#signup-email').fill(EMAIL);
    await page.locator('#signup-password').fill('short1');
    await page.locator('#signup-confirm').fill('short1');
    await page.locator('#signup-submit').click();
    assert.equal(await page.locator('#signup-password').evaluate(i => i.validity.tooShort), true);
    assert.equal(await page.locator('#signup-password').getAttribute('minlength'), '8');

    await page.locator('#signup-password').fill('correct-horse-battery');
    await page.locator('#signup-confirm').fill('different-passphrase');
    await page.locator('#signup-submit').click();
    assert.match(await text(page, 'signup-error'), /do not match/i);
    assert.equal(backend.authRequests.filter(r => r.path === 'signup').length, 0);
  });

  await check('A wrong password reports exactly the contract message and keeps the email', async ({ page, backend }) => {
    backend.signIn = { status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page, { password: 'wrong' });

    await page.locator('#signin-error:not([hidden])').waitFor();
    assert.equal((await text(page, 'signin-error')).trim(), 'Email or password is incorrect.');
    assert.equal(await page.locator('#signin-email').inputValue(), EMAIL, 'a failed attempt keeps the input');
    assert.equal(await visible(page, 'resend-row'), false);
  });

  await check('The legacy invalid_grant shape maps to the same message', async ({ page, backend }) => {
    backend.signIn = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid login credentials' } };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page, { password: 'wrong' });
    await page.locator('#signin-error:not([hidden])').waitFor();
    assert.equal((await text(page, 'signin-error')).trim(), 'Email or password is incorrect.');
  });

  await check('An unconfirmed email explains itself and offers to resend', async ({ page, backend }) => {
    backend.signIn = { status: 400, body: { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' } };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);

    await page.locator('#signin-error:not([hidden])').waitFor();
    assert.match(await text(page, 'signin-error'), /Confirm your email first/i);
    assert.equal(await visible(page, 'resend-row'), true);

    await page.locator('#resend-confirmation').click();
    await page.locator('#account-status[data-state=success]').waitFor();
    assert.match(await text(page, 'account-status'), /Confirmation email sent/i);
    assert.ok(backend.authRequests.some(r => r.path === 'resend'));
  });

  await check('Too many attempts reports the rate-limit message', async ({ page, backend }) => {
    backend.signIn = { status: 429, body: { code: 429, error_code: 'over_request_rate_limit', msg: 'rate limited' } };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#signin-error:not([hidden])').waitFor();
    assert.match(await text(page, 'signin-error'), /Too many attempts/i);
  });

  await check('Forgot password always gives the same neutral answer', async ({ page, backend }) => {
    await page.goto(`${BASE}/account.html#forgot`, { waitUntil: 'networkidle' });
    assert.equal(await visible(page, 'view-forgot'), true);

    await page.locator('#forgot-email').fill('someone@example.com');
    await page.locator('#forgot-submit').click();
    await page.locator('#account-status[data-state=success]').waitFor();
    assert.match(await text(page, 'account-status'), /If an account exists/i);
    assert.ok(backend.authRequests.some(r => r.path === 'recover'));
  });

  await check('A rate-limited reset request says so instead of claiming success', async ({ page, backend }) => {
    backend.recover = { status: 429, body: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'rate limited' } };
    await page.goto(`${BASE}/account.html#forgot`, { waitUntil: 'networkidle' });
    await page.locator('#forgot-email').fill('someone@example.com');
    await page.locator('#forgot-submit').click();
    await page.locator('#forgot-error:not([hidden])').waitFor();
    assert.match(await text(page, 'forgot-error'), /Too many attempts/i);
  });

  await check('A recovery link opens the set-new-password view and saves the password', async ({ page }) => {
    const fragment = new URLSearchParams({
      access_token: jwt(),
      refresh_token: 'refresh-token-1',
      expires_in: '3600',
      token_type: 'bearer',
      type: 'recovery'
    });
    await page.goto(`${BASE}/account.html#${fragment}`, { waitUntil: 'networkidle' });

    await page.locator('#view-reset:not([hidden])').waitFor();
    assert.equal(await visible(page, 'view-reset'), true);

    await page.locator('#reset-password').fill('a-brand-new-passphrase');
    await page.locator('#reset-confirm').fill('a-brand-new-passphrase');
    await page.locator('#reset-submit').click();
    await page.locator('#account-status[data-state=success]').waitFor();
    assert.match(await text(page, 'account-status'), /password has been changed/i);
  });

  await check('An expired email link explains itself and offers a new one', async ({ page, backend }) => {
    const fragment = new URLSearchParams({
      error: 'access_denied',
      error_code: 'otp_expired',
      error_description: 'Email link is invalid or has expired'
    });
    await page.goto(`${BASE}/account.html#${fragment}`, { waitUntil: 'networkidle' });

    assert.equal(await visible(page, 'view-link-error'), true);
    assert.match(await text(page, 'link-error-detail'), /expired/i);
    assert.deepEqual(backend.functionRequests, [], 'a dead link must not trigger an entitlement call');

    await page.locator('#view-link-error a[data-view-link=forgot]').click();
    assert.equal(await visible(page, 'view-forgot'), true);
  });

  // ---------------------------------------------------------------- the subscription card
  const CARD_CASES = [
    ['active', /^Active$/, /renews on/i, { manage: true, subscribe: false }],
    ['trialing', /Free trial/i, /trial ends on/i, { manage: true, subscribe: false }],
    ['canceled_pending', /^Canceled$/, /access until/i, { manage: true, subscribe: false }],
    ['past_due_grace', /payment failed/i, /Update your card/i, { manage: true, subscribe: false }],
    ['payment_failed', /No active subscription/i, /Subscribe to use Prop Layer/i, { manage: true, subscribe: true }],
    ['expired', /No active subscription/i, /Subscribe to use Prop Layer/i, { manage: true, subscribe: true }],
    ['incomplete', /No active subscription/i, /not completed/i, { manage: true, subscribe: true }],
    ['no_subscription', /Prop Layer Monthly/i, /Cancel anytime/i, { manage: false, subscribe: true }]
  ];

  for (const [reason, title, detail, buttons] of CARD_CASES) {
    await check(`The subscription card for ${reason} reads correctly`, async ({ page, backend }) => {
      backend.entitlement = entitlement(reason);
      await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
      await signIn(page);

      await page.locator('#view-account:not([hidden])').waitFor();
      await page.locator('#subscription-title').filter({ hasText: /\S/ }).waitFor();
      await page.waitForFunction(
        () => !/Checking your subscription/i.test(document.getElementById('subscription-title').textContent)
      );

      assert.match(await text(page, 'subscription-title'), title);
      assert.match(await text(page, 'subscription-detail'), detail);
      assert.equal(await visible(page, 'manage-button'), buttons.manage, `${reason}: manage button`);
      assert.equal(await visible(page, 'subscribe-button'), buttons.subscribe, `${reason}: subscribe button`);
      assert.equal(await text(page, 'account-email'), EMAIL);

      if (buttons.subscribe) {
        assert.match(await text(page, 'subscribe-button'), /\$14\.99 \/ month/, 'the price comes from config');
      }
      if (reason === 'no_subscription') {
        assert.equal(await visible(page, 'subscription-includes'), true, 'a new visitor sees what is included');
      }
      // The entitlement response is the only thing consulted.
      assert.ok(backend.functionRequests.some(r => r.name === 'entitlement' && r.method === 'GET'));
    });
  }

  // ---------------------------------------------------------------- checkout and portal
  await check('Subscribe navigates to the Stripe Checkout URL', async ({ page, backend }) => {
    backend.entitlement = entitlement('no_subscription');
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#subscribe-button:not([hidden])').waitFor();

    await Promise.all([
      page.waitForURL(url => url.href.startsWith('https://checkout.stripe.com/')),
      page.locator('#subscribe-button').click()
    ]);
    assert.equal(await page.locator('#stripe-stub').count(), 1);
    assert.ok(backend.functionRequests.some(r => r.name === 'create-checkout-session' && r.method === 'POST'));
  });

  await check('Subscribe shows a pending state and cannot be double-clicked', async ({ page, backend }) => {
    backend.entitlement = entitlement('no_subscription');
    // Hold the checkout call open long enough to observe the pending state.
    await page.route(`${SUPABASE_URL}/functions/v1/create-checkout-session`, async route => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: CORS(BASE), body: '' });
      }
      backend.functionRequests.push({ name: 'create-checkout-session', method: 'POST' });
      await new Promise(resolve => setTimeout(resolve, 1200));
      return jsonResponse(route, 200, { url: CHECKOUT_URL }, BASE);
    });

    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#subscribe-button:not([hidden])').waitFor();

    await page.locator('#subscribe-button').click();
    await page.locator('#subscribe-button[aria-busy=true]').waitFor();
    assert.equal(await page.locator('#subscribe-button').isDisabled(), true);
    await page.locator('#subscribe-button').click({ force: true, noWaitAfter: true }).catch(() => {});
    await page.waitForURL(url => url.href.startsWith('https://checkout.stripe.com/'));
    assert.equal(
      backend.functionRequests.filter(r => r.name === 'create-checkout-session').length, 1,
      'a disabled button must not start a second checkout'
    );
  });

  await check('A 409 on subscribe re-reads entitlement and shows the active card', async ({ page, backend }) => {
    backend.entitlement = entitlement('no_subscription');
    backend.checkout = { status: 409, body: { error: 'already_subscribed', message: 'You already have an active subscription. Use Manage billing.' } };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#subscribe-button:not([hidden])').waitFor();

    // The second read of the truth finds the subscription that was already there.
    backend.entitlement = entitlement('active');
    await page.locator('#subscribe-button').click();

    await page.waitForFunction(() => /^Active$/.test(document.getElementById('subscription-title').textContent));
    assert.equal(await visible(page, 'manage-button'), true);
    assert.equal(await visible(page, 'subscribe-button'), false);
    assert.match(await text(page, 'account-status'), /already have an active subscription/i);
    assert.equal(page.url().startsWith(BASE), true, 'no redirect happens on 409');
  });

  await check('Manage billing navigates to the Stripe Customer Portal', async ({ page, backend }) => {
    backend.entitlement = entitlement('active');
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#manage-button:not([hidden])').waitFor();

    await Promise.all([
      page.waitForURL(url => url.href.startsWith('https://billing.stripe.com/')),
      page.locator('#manage-button').click()
    ]);
    assert.ok(backend.functionRequests.some(r => r.name === 'create-portal-session' && r.method === 'POST'));
  });

  await check('A 404 from the portal hides the Manage billing button', async ({ page, backend }) => {
    backend.entitlement = entitlement('expired');
    backend.portal = { status: 404, body: { error: 'no_customer', message: 'No billing account exists for this user yet.' } };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#manage-button:not([hidden])').waitFor();

    await page.locator('#manage-button').click();
    await page.locator('#manage-button').waitFor({ state: 'hidden' });
    assert.equal(await visible(page, 'manage-button'), false);
    assert.match(await text(page, 'subscription-error'), /no billing history/i);
    assert.equal(page.url().startsWith(BASE), true);
  });

  await check('?checkout=success polls until the subscription is active', async ({ page, backend }) => {
    // Two "not yet" answers, then the webhook has landed.
    backend.entitlementQueue = [
      { status: 200, body: entitlement('no_subscription') },
      { status: 200, body: entitlement('no_subscription') },
      { status: 200, body: entitlement('active') }
    ];
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#view-account:not([hidden])').waitFor();

    backend.entitlementQueue = [
      { status: 200, body: entitlement('no_subscription') },
      { status: 200, body: entitlement('no_subscription') },
      { status: 200, body: entitlement('no_subscription') },
      { status: 200, body: entitlement('no_subscription') },
      { status: 200, body: entitlement('active') }
    ];
    await page.goto(`${BASE}/account.html?checkout=success`, { waitUntil: 'commit' });

    await page.waitForFunction(
      () => /Activating your subscription/i.test(document.getElementById('account-status').textContent)
    );
    await page.locator('#account-status[data-state=success]').waitFor({ timeout: 20_000 });
    assert.match(await text(page, 'account-status'), /all set/i);
    assert.match(await text(page, 'subscription-title'), /^Active$/);
    // The query string must not survive, so a refresh does not poll again.
    assert.equal(new URL(page.url()).search, '');
  });

  await check('Activation that never completes explains what to do next', async ({ page, backend }) => {
    backend.entitlement = entitlement('no_subscription');
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#view-account:not([hidden])').waitFor();

    // Fast-forward the page's own clock rather than waiting out the real 60 s budget.
    await page.clock.install();
    await page.goto(`${BASE}/account.html?checkout=success`, { waitUntil: 'networkidle' });
    assert.match(await text(page, 'account-status'), /Activating your subscription/i);

    await page.clock.runFor(70_000);
    await page.waitForFunction(
      () => /taking longer than usual/i.test(document.getElementById('account-status').textContent),
      null,
      { timeout: 20_000 }
    );
    assert.match(await text(page, 'account-status'), /Refresh in a minute or email Help@prop-layer\.com/i);
  });

  await check('?checkout=canceled is a neutral notice, not an error', async ({ page, backend }) => {
    backend.entitlement = entitlement('no_subscription');
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#view-account:not([hidden])').waitFor();

    await page.goto(`${BASE}/account.html?checkout=canceled#subscribe`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /Checkout canceled/i.test(document.getElementById('account-status').textContent));
    assert.match(await text(page, 'account-status'), /you weren't charged/i);
    assert.equal(await page.locator('#account-status').getAttribute('data-state'), 'info');
    assert.equal(new URL(page.url()).search, '');
  });

  // ---------------------------------------------------------------- intent, session, failure
  await check('A #subscribe intent survives signing in', async ({ page, backend }) => {
    backend.entitlement = entitlement('no_subscription');
    await page.goto(`${BASE}/account.html#subscribe`, { waitUntil: 'networkidle' });

    assert.equal(await visible(page, 'view-signin'), true);
    assert.match(await text(page, 'account-status'), /Sign in or create an account to subscribe/i);

    await Promise.all([
      page.waitForURL(url => url.href.startsWith('https://checkout.stripe.com/')),
      signIn(page)
    ]);
    assert.ok(backend.functionRequests.some(r => r.name === 'create-checkout-session'));
  });

  await check('A #billing intent survives signing in', async ({ page, backend }) => {
    backend.entitlement = entitlement('active');
    await page.goto(`${BASE}/account.html#billing`, { waitUntil: 'networkidle' });
    assert.match(await text(page, 'account-status'), /Sign in to manage your billing/i);

    await Promise.all([
      page.waitForURL(url => url.href.startsWith('https://billing.stripe.com/')),
      signIn(page)
    ]);
    assert.ok(backend.functionRequests.some(r => r.name === 'create-portal-session'));
  });

  await check('A 401 from entitlement triggers exactly one refresh and one retry', async ({ page, backend }) => {
    backend.entitlementQueue = [
      { status: 401, body: { error: 'unauthorized', message: 'Sign in again.' } },
      { status: 200, body: entitlement('active') }
    ];
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);

    await page.waitForFunction(() => /^Active$/.test(document.getElementById('subscription-title').textContent));
    assert.equal(backend.authRequests.filter(r => r.grant === 'refresh_token').length, 1, 'one refresh, not a loop');
    assert.equal(backend.functionRequests.filter(r => r.name === 'entitlement').length, 2);
    assert.equal(await visible(page, 'view-account'), true);
  });

  await check('A 401 whose refresh fails signs the visitor out with a clear message', async ({ page, backend }) => {
    backend.entitlementStatus = 401;
    backend.entitlement = { error: 'unauthorized', message: 'Sign in again.' };
    backend.refresh = { status: 400, body: { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);

    await page.waitForFunction(
      () => /Please sign in again/i.test(document.getElementById('account-status').textContent)
    );
    assert.equal(await visible(page, 'view-signin'), true);
    assert.equal(await visible(page, 'view-account'), false);
  });

  await check('A 5xx shows a retry banner, and Retry succeeds', async ({ page, backend }) => {
    backend.entitlementQueue = [{ status: 500, body: { error: 'internal', message: 'Something went wrong. Try again.' } }];
    backend.entitlement = entitlement('active');
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);

    await page.locator('#retry-button:not([hidden])').waitFor();
    assert.match(await text(page, 'subscription-title'), /couldn't check your subscription/i);
    assert.equal(await visible(page, 'view-signin'), false, 'a 5xx is never treated as signed out');

    await page.locator('#retry-button').click();
    await page.waitForFunction(() => /^Active$/.test(document.getElementById('subscription-title').textContent));
    assert.equal(await visible(page, 'retry-button'), false);
  });

  await check('A dropped connection is treated as offline, not as signed out', async ({ page, backend }) => {
    backend.entitlementQueue = [{ status: 0 }];
    backend.entitlement = entitlement('active');
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);

    await page.locator('#retry-button:not([hidden])').waitFor();
    assert.match(await text(page, 'subscription-detail'), /couldn't reach the account service/i);
    assert.equal(await visible(page, 'view-account'), true);
  });

  await check('A 503 from entitlement says subscriptions are opening soon', async ({ page, backend }) => {
    backend.entitlementStatus = 503;
    backend.entitlement = { error: 'not_configured', message: 'The account service is not configured yet.' };
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);

    await page.waitForFunction(() => /opening soon/i.test(document.getElementById('subscription-title').textContent));
    assert.equal(await visible(page, 'retry-button'), false, 'retrying will not help an unconfigured backend');
  });

  await check('Blocked storage still signs in, with a warning', async ({ context, backend }) => {
    backend.entitlement = entitlement('active');
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('Blocked'); } });
      Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Blocked'); } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);

    await page.locator('#view-account:not([hidden])').waitFor();
    await page.waitForFunction(() => /^Active$/.test(document.getElementById('subscription-title').textContent));
    assert.match(await text(page, 'account-status'), /blocking storage/i);
    assert.deepEqual(errors, []);
  });

  await check('Signing out clears the session and returns to sign in', async ({ page, backend }) => {
    backend.entitlement = entitlement('active');
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#view-account:not([hidden])').waitFor();

    await page.locator('#sign-out').click();
    await page.locator('#view-signin:not([hidden])').waitFor();
    assert.equal(await visible(page, 'view-account'), false);

    // A reload must not restore the session.
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await visible(page, 'view-signin'), true);
    assert.equal(await visible(page, 'view-account'), false);
  });

  await check('No token, email address or user id is ever sent to analytics', async ({ page, backend }) => {
    backend.entitlement = entitlement('no_subscription');
    const analytics = [];
    await page.route('**/google-analytics.com/**', route => {
      analytics.push(route.request().url() + (route.request().postData() ?? ''));
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#subscribe-button:not([hidden])').waitFor();
    await page.locator('#subscribe-button').click().catch(() => {});
    await page.waitForTimeout(500);

    for (const hit of analytics) {
      assert.doesNotMatch(hit, /fan%40example|fan@example/, 'no email in analytics');
      assert.ok(!hit.includes(USER_ID), 'no user id in analytics');
      assert.doesNotMatch(hit, /eyJhbGciOi/, 'no JWT in analytics');
    }
  });

  // ---------------------------------------------------------------- download page
  await check('The download page renders the version, size, digest and FFmpeg link', async ({ page }) => {
    await page.goto(`${BASE}/download.html`, { waitUntil: 'networkidle' });

    await page.locator('#release-download:not([hidden])').waitFor();
    assert.match(await text(page, 'release-title'), /Prop Layer 0\.1\.0 for Windows/);
    assert.equal(await text(page, 'release-version'), '0.1.0');
    assert.equal(await text(page, 'release-size'), '117 MB');
    assert.match(await text(page, 'release-published'), /2026/);
    assert.equal(
      await page.locator('#release-download').getAttribute('href'),
      `https://github.com/${RELEASES_REPO}/releases/download/v0.1.0/PropLayer-Setup-0.1.0.exe`
    );
    assert.equal(
      await text(page, 'release-hash-value'),
      '9f2c4a1e8b4d4c1a9e2f5a7b9c0d1e2f3a4b5c6d7e8f90123456789abcdef012'
    );
    assert.match(await page.locator('#release-ffmpeg').getAttribute('href'), /ffmpeg-source.*\.zip$/);
    assert.match(await page.locator('#release-checksums').getAttribute('href'), /SHA256SUMS\.txt$/);
    assert.equal(await visible(page, 'release-fallback'), false);

    // The release body is the build's DOWNLOAD-NOTICE.md and must be readable, not raw.
    assert.equal(await visible(page, 'release-notes-card'), true);
    const notes = await text(page, 'release-notes');
    assert.match(notes, /FFmpeg is included under the LGPL/);
    assert.doesNotMatch(notes, /\*\*/, 'markdown is rendered, not shown literally');
    assert.equal(await page.locator('#release-notes code').first().textContent(), 'PropLayer-ffmpeg-source-electron-v38.2.2-win32-x64.zip');
    assert.equal(await page.locator('#release-notes a[href="https://prop-layer.com/terms.html"]').count(), 1);
  });

  await check('Release notes never become live HTML', async ({ page, backend }) => {
    backend.release = {
      status: 200,
      body: {
        ...RELEASE,
        body: '<img src=x onerror="window.__xss=1">\n\n[click](javascript:window.__xss2=1)\n\n<script>window.__xss3=1</script>'
      }
    };
    await page.goto(`${BASE}/download.html`, { waitUntil: 'networkidle' });
    await page.locator('#release-notes-card:not([hidden])').waitFor();

    assert.equal(await page.evaluate(() => window.__xss ?? window.__xss2 ?? window.__xss3 ?? null), null);
    assert.equal(await page.locator('#release-notes img, #release-notes script').count(), 0);
    assert.equal(await page.locator('#release-notes a[href^="javascript:"]').count(), 0);
    assert.match(await text(page, 'release-notes'), /onerror/, 'the markup is shown as text');
  });

  await check('A GitHub 403 falls back to the releases page', async ({ page, backend }) => {
    backend.release = { status: 403, body: { message: 'API rate limit exceeded' } };
    await page.goto(`${BASE}/download.html`, { waitUntil: 'networkidle' });

    await page.locator('#release-fallback:not([hidden])').waitFor();
    assert.match(await text(page, 'release-fallback-detail'), /rate-limiting/i);
    assert.equal(
      await page.locator('#release-fallback-link').getAttribute('href'),
      `https://github.com/${RELEASES_REPO}/releases/latest`
    );
    assert.equal(await visible(page, 'release-download'), false);
  });

  await check('A release with no installer asset falls back', async ({ page, backend }) => {
    backend.release = { status: 200, body: { ...RELEASE, assets: [] } };
    await page.goto(`${BASE}/download.html`, { waitUntil: 'networkidle' });
    await page.locator('#release-fallback:not([hidden])').waitFor();
    assert.match(await text(page, 'release-fallback-detail'), /does not include a Windows installer/i);
  });

  await check('A 404 (no release published yet) and a network failure both fall back', async ({ context, backend }) => {
    backend.release = { status: 404, body: { message: 'Not Found' } };
    const first = await context.newPage();
    await first.goto(`${BASE}/download.html`, { waitUntil: 'networkidle' });
    await first.locator('#release-fallback:not([hidden])').waitFor();
    assert.match(await first.locator('#release-fallback-detail').textContent(), /No public release/i);

    backend.release = { status: 0 };
    const second = await context.newPage();
    await second.goto(`${BASE}/download.html`, { waitUntil: 'networkidle' });
    await second.locator('#release-fallback:not([hidden])').waitFor();
    assert.match(await second.locator('#release-fallback-detail').textContent(), /couldn't reach GitHub/i);
  });

  await check('The download page works without JavaScript and needs no account', async ({ context }) => {
    const noJS = await context.browser().newContext({ javaScriptEnabled: true });
    await noJS.close();
    const plainContext = await context.browser().newContext({ javaScriptEnabled: false });
    const plain = await plainContext.newPage();
    await plain.goto(`${BASE}/download.html`);
    assert.equal(await plain.locator('noscript').isVisible(), true);
    const href = await plain.locator('noscript a').first().getAttribute('href');
    assert.match(href, /releases\/latest$/);
    await plainContext.close();
  });

  // ---------------------------------------------------------------- layout and links
  await check('The new pages have no horizontal overflow from 360 to 1440 px', async ({ page, backend }) => {
    backend.entitlement = entitlement('canceled_pending');
    for (const path of ['account.html', 'download.html']) {
      await page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle' });
      if (path === 'account.html') {
        await signIn(page);
        await page.locator('#view-account:not([hidden])').waitFor();
      } else {
        await page.locator('#release-download:not([hidden])').waitFor();
      }
      for (const width of [360, 390, 768, 1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
          `${path} overflows at ${width}px`
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  });

  await check('Every form control on the new pages is labelled and focusable', async ({ page }) => {
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll('#main input:not([type=hidden])')]
        .filter(input => !input.labels?.length && !input.getAttribute('aria-label'))
        .map(input => input.id || input.name)
    );
    assert.deepEqual(unlabelled, []);

    await page.locator('#signin-email').focus();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'signin-email');
    await page.locator('[data-toggle-password=signin-password]').click();
    assert.equal(await page.locator('#signin-password').getAttribute('type'), 'text');
    assert.equal(await page.locator('[data-toggle-password=signin-password]').getAttribute('aria-pressed'), 'true');
  });

  await check('Nav and footer links resolve on every page, including the new ones', async ({ page, context }) => {
    const pages = ['index.html', 'account.html', 'download.html', 'partners.html', 'privacy.html', 'terms.html', '404.html', 'logo.html'];
    for (const file of pages) {
      await page.goto(`${BASE}/${file}`, { waitUntil: 'domcontentloaded' });
      const hrefs = await page.locator('a[href]').evaluateAll(items =>
        [...new Set(items.map(a => a.getAttribute('href')))]
      );
      for (const href of hrefs) {
        if (href.startsWith('#')) {
          if (href === '#') continue;
          // account.html routes its own fragments in JS, where the target is #view-<name>.
          const name = href.slice(1);
          assert.ok(await page.locator(`#${name}, #view-${name}`).count(), `${file} → ${href}`);
        } else if (!href.includes(':')) {
          const [path, fragment] = href.replace(/^\//, '').split('#');
          if (path) {
            const response = await context.request.get(`${BASE}/${path}`);
            assert.ok(response.ok(), `${file} → ${href} (${response.status()})`);
          }
          if (fragment && !path) {
            assert.ok(await page.locator(`#${fragment}, #view-${fragment}`).count(), `${file} → ${href}`);
          }
        }
      }
      // Both new destinations must be reachable from every page's navigation.
      for (const destination of ['download.html', 'account.html']) {
        assert.ok(
          await page.locator(`.nav-links a[href$="${destination}"]`).count(),
          `${file} nav is missing ${destination}`
        );
      }
    }
  });

  await check('Both new pages set the contract Content-Security-Policy', async ({ page }) => {
    for (const [file, connect] of [['account.html', 'https://*.supabase.co'], ['download.html', 'https://api.github.com']]) {
      await page.goto(`${BASE}/${file}`, { waitUntil: 'domcontentloaded' });
      const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
      assert.ok(csp.includes("default-src 'self'"), file);
      assert.ok(csp.includes(connect), `${file} must allow ${connect}`);
      assert.ok(csp.includes("base-uri 'self'"), file);
      assert.ok(!csp.includes("'unsafe-inline'"), `${file} must not allow inline script`);
      assert.equal(await page.locator('script:not([src])').count(), 0, `${file} must have no inline script`);
    }
    await page.goto(`${BASE}/account.html`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), 'noindex');
  });

  await check('index.html advertises the plan and price from config', async ({ page }) => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#pricing').count(), 1);
    assert.equal(await text(page, 'plan-price'), PRICE_DISPLAY);
    assert.equal(await text(page, 'plan-name'), 'Prop Layer Monthly');
    assert.equal(await page.locator('#pricing a[href="account.html#subscribe"]').count(), 1);
    assert.equal(await page.locator('.nav-cta').getAttribute('href'), '#pricing');
  });

  // ---------------------------------------------------------------- screenshots
  {
    const backend = createBackend();
    backend.entitlement = entitlement('active');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await installMocks(context, backend);
    const page = await context.newPage();
    await page.goto(`${BASE}/account.html`, { waitUntil: 'networkidle' });
    await signIn(page);
    await page.locator('#view-account:not([hidden])').waitFor();
    await page.waitForFunction(() => /^Active$/.test(document.getElementById('subscription-title').textContent));
    await page.screenshot({ path: 'artifacts/account-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/account-mobile.png', fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE}/download.html`, { waitUntil: 'networkidle' });
    await page.locator('#release-download:not([hidden])').waitFor();
    await page.screenshot({ path: 'artifacts/download-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/download-mobile.png', fullPage: true });
    await context.close();
  }

  await browser.close();

  fs.writeFileSync('artifacts/account-verification.json', JSON.stringify({
    browser: CHANNEL,
    passed: checks,
    failed: failures.map(f => ({ name: f.name, error: f.error.message })),
    note: 'Supabase Auth, Edge Functions, GitHub and Stripe are all locally intercepted. No real service was contacted.'
  }, null, 2));

  if (failures.length) {
    console.error(`\n${failures.length} of ${checks.length + failures.length} account checks failed.`);
    process.exit(1);
  }
  console.log(`${checks.length} account checks passed (${CHANNEL}).`);
})().catch(error => { console.error(error); process.exit(1); });
