/* Prop Layer account page. Contract PL-ACCOUNT-1 (C3, C5, C7).

   Two rules shape everything here:
   - `entitlement` is the only source of subscription truth. This page never infers access
     from a Stripe status, a cached flag or a redirect it just came back from.
   - Every string that came from the network is written with textContent. No innerHTML.
*/
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const config = window.PROPLAYER_CONFIG ?? {};
  const PLACEHOLDER = '__SET_ME__';

  // ------------------------------------------------------------------ views
  const VIEWS = ['loading', 'unconfigured', 'signin', 'signup', 'forgot', 'reset', 'link-error', 'account'];
  const SIGNED_OUT_VIEWS = ['signin', 'signup', 'forgot'];
  let currentView = 'loading';

  function showView(name, { focus = true } = {}) {
    currentView = name;
    for (const view of VIEWS) {
      const node = $(`view-${view}`);
      if (node) node.hidden = view !== name;
    }
    const heading = document.querySelector(`#view-${name} h1`);
    if (focus && heading) heading.focus();
  }

  /** The page-level status line. Plain text only; `kind` drives the colour. */
  function setStatus(message, kind = 'info') {
    const status = $('account-status');
    status.textContent = message ?? '';
    if (message) status.dataset.state = kind;
    else delete status.dataset.state;
  }

  function setFieldError(id, message) {
    const node = $(id);
    if (!node) return;
    node.textContent = message ?? '';
    node.hidden = !message;
  }

  function clearFieldErrors() {
    for (const id of ['signin-error', 'signup-error', 'forgot-error', 'reset-error', 'subscription-error']) {
      setFieldError(id, '');
    }
  }

  // ------------------------------------------------------------------ not configured
  const configured = ['supabaseUrl', 'supabasePublishableKey'].every(
    key => typeof config[key] === 'string' && config[key] && config[key] !== PLACEHOLDER
  );

  if (!configured) {
    // Deliberately before the Supabase client is created: this path makes no network call.
    showView('unconfigured');
    return;
  }

  if (!window.supabase?.createClient) {
    showView('unconfigured');
    setStatus('The account service could not load. Refresh the page or email Help@prop-layer.com.', 'error');
    return;
  }

  // ------------------------------------------------------------------ storage
  /**
   * localStorage throws outright in some privacy modes, so it is probed once and replaced
   * with an in-memory store when unusable. The session then lasts for this tab only, and
   * the visitor is told so rather than being silently signed out later.
   */
  let storageIsPersistent = true;
  function resolveStorage() {
    try {
      const probe = '__proplayer_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch {
      storageIsPersistent = false;
      const memory = new Map();
      return {
        getItem: key => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => void memory.set(key, String(value)),
        removeItem: key => void memory.delete(key)
      };
    }
  }

  /** sessionStorage is used only for a remembered intent, and may equally be blocked. */
  const intentStore = (() => {
    try {
      const probe = '__proplayer_probe__';
      window.sessionStorage.setItem(probe, '1');
      window.sessionStorage.removeItem(probe);
      return window.sessionStorage;
    } catch {
      let held = null;
      return {
        getItem: () => held,
        setItem: (_key, value) => { held = String(value); },
        removeItem: () => { held = null; }
      };
    }
  })();

  const INTENT_KEY = 'proplayer_intent';
  const rememberIntent = intent => { try { intentStore.setItem(INTENT_KEY, intent); } catch { /* ignore */ } };
  const takeIntent = () => {
    try {
      const intent = intentStore.getItem(INTENT_KEY);
      intentStore.removeItem(INTENT_KEY);
      return intent;
    } catch {
      return null;
    }
  };

  const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'implicit',
      storage: resolveStorage()
    }
  });

  /** Email links must return to this origin in development, and to siteUrl in production. */
  const redirectOrigin = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? location.origin
    : String(config.siteUrl ?? 'https://prop-layer.com').replace(/\/+$/, '');

  // ------------------------------------------------------------------ analytics
  /** Contract: event names only. No ids, no email, no value. */
  function track(name) {
    if (typeof window.gtag === 'function') window.gtag('event', name);
  }

  // ------------------------------------------------------------------ errors
  const MESSAGES = {
    invalid_credentials: 'Email or password is incorrect.',
    email_not_confirmed: 'Confirm your email first — check your inbox, then sign in.',
    rate_limited: 'Too many attempts. Wait a few minutes and try again.',
    signed_out: 'Please sign in again.',
    offline: "We couldn't reach the account service. Try again.",
    generic: 'Something went wrong. Please try again.'
  };

  /**
   * Supabase returns either `{code, error_code, msg}` or the legacy
   * `{error, error_description}`. Both shapes are parsed (contract C3).
   */
  function describeAuthError(error) {
    if (!error) return { message: MESSAGES.generic };
    const status = Number(error.status ?? 0);
    const code = String(error.code ?? error.error_code ?? error.error ?? '').toLowerCase();
    const text = String(error.message ?? error.msg ?? error.error_description ?? '').toLowerCase();

    if (status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
      return { message: MESSAGES.rate_limited };
    }
    if (code === 'email_not_confirmed' || text.includes('not confirmed')) {
      return { message: MESSAGES.email_not_confirmed, notConfirmed: true };
    }
    if (code === 'invalid_credentials' || code === 'invalid_grant' || text.includes('invalid login credentials')) {
      return { message: MESSAGES.invalid_credentials };
    }
    if (code === 'weak_password' || text.includes('password should be at least')) {
      return { message: 'Choose a password with at least 8 characters.' };
    }
    if (code === 'validation_failed' && text.includes('email')) {
      return { message: 'Enter a valid email address.' };
    }
    if (!status || status >= 500) return { message: MESSAGES.offline, offline: true };
    return { message: error.message || MESSAGES.generic };
  }

  // ------------------------------------------------------------------ pending buttons
  const pendingLabels = new WeakMap();

  function setPending(button, pending, label = 'Working…') {
    if (!button) return;
    if (pending) {
      if (!pendingLabels.has(button)) pendingLabels.set(button, button.textContent);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = label;
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (pendingLabels.has(button)) {
        button.textContent = pendingLabels.get(button);
        pendingLabels.delete(button);
      }
    }
  }

  // ------------------------------------------------------------------ the backend
  const FUNCTIONS_BASE = `${String(config.supabaseUrl).replace(/\/+$/, '')}/functions/v1`;
  const REQUEST_TIMEOUT_MS = 15_000;

  async function accessToken() {
    const { data } = await client.auth.getSession();
    return data?.session?.access_token ?? null;
  }

  /**
   * One call to an Edge Function. Returns `{status, body}` and never throws for an HTTP
   * error; a transport failure or timeout comes back as status 0, which every caller treats
   * as "offline", never as "signed out" (contract C3/C6).
   */
  async function callFunction(path, { method = 'GET', token } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${FUNCTIONS_BASE}/${path}`, {
        method,
        headers: {
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: controller.signal
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, body };
    } catch {
      return { status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `entitlement`, with the one refresh-and-retry a 401 is allowed (contract C6 rule 5).
   * A second 401 means the session really is over.
   */
  async function fetchEntitlement({ allowRefresh = true } = {}) {
    const token = await accessToken();
    if (!token) return { state: 'signed_out' };

    const { status, body } = await callFunction('entitlement', { token });

    if (status === 200 && body) return { state: 'ok', entitlement: body };

    if (status === 401) {
      if (!allowRefresh) return { state: 'signed_out' };
      const { data, error } = await client.auth.refreshSession();
      if (error || !data?.session) return { state: 'signed_out' };
      return await fetchEntitlement({ allowRefresh: false });
    }

    if (status === 503) return { state: 'unconfigured' };
    // 0 (transport), 5xx and 502 are all "we could not get an answer", not "no access".
    return { state: 'offline', status };
  }

  // ------------------------------------------------------------------ subscription card
  const longDate = value => {
    const ms = Date.parse(value ?? '');
    if (!Number.isFinite(ms)) return 'your next renewal date';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(ms));
  };

  const priceLabel = () =>
    (typeof config.priceDisplay === 'string' && config.priceDisplay !== PLACEHOLDER && config.priceDisplay)
      ? config.priceDisplay
      : null;

  /** One row of the contract C5 reason table → one card. */
  function renderSubscription(entitlement) {
    const title = $('subscription-title');
    const detail = $('subscription-detail');
    const includes = $('subscription-includes');
    const subscribe = $('subscribe-button');
    const manage = $('manage-button');
    const retry = $('retry-button');

    includes.hidden = true;
    subscribe.hidden = true;
    manage.hidden = true;
    retry.hidden = true;
    setFieldError('subscription-error', '');

    const until = entitlement.subscription?.access_until ?? entitlement.subscription?.current_period_end ?? null;
    const price = priceLabel();

    switch (entitlement.reason) {
      case 'active':
        title.textContent = 'Active';
        detail.textContent = `Your subscription renews on ${longDate(until)}.`;
        manage.hidden = false;
        break;

      case 'trialing':
        title.textContent = 'Free trial';
        detail.textContent = `Your trial ends on ${longDate(until)}.`;
        manage.hidden = false;
        break;

      case 'canceled_pending':
        title.textContent = 'Canceled';
        detail.textContent = `You have access until ${longDate(until)}. You can resume any time before then.`;
        manage.textContent = 'Resume or manage';
        manage.hidden = false;
        break;

      case 'past_due_grace':
        title.textContent = 'Your last payment failed';
        detail.textContent = 'Update your card to keep access. We retry for up to a week before the subscription ends.';
        manage.textContent = 'Update payment method';
        manage.hidden = false;
        break;

      case 'payment_failed':
      case 'expired':
      case 'incomplete':
        title.textContent = 'No active subscription';
        detail.textContent = entitlement.reason === 'incomplete'
          ? 'Your last checkout was not completed. Subscribe to finish it.'
          : 'Subscribe to use Prop Layer. The download stays free either way.';
        subscribe.textContent = price ? `Subscribe — ${price}` : 'Subscribe';
        subscribe.hidden = false;
        // A returning customer has a portal; a 404 from the portal hides this again.
        manage.hidden = false;
        break;

      case 'no_subscription':
      default:
        title.textContent = String(config.planName ?? 'Prop Layer Monthly');
        detail.textContent = price
          ? `${price}. Cancel anytime — access continues to the end of the paid period.`
          : 'Cancel anytime — access continues to the end of the paid period.';
        includes.hidden = false;
        subscribe.textContent = price ? `Subscribe — ${price}` : 'Subscribe';
        subscribe.hidden = false;
        break;
    }
  }

  function renderSubscriptionProblem(kind) {
    const title = $('subscription-title');
    const detail = $('subscription-detail');
    $('subscription-includes').hidden = true;
    $('subscribe-button').hidden = true;
    $('manage-button').hidden = true;
    $('retry-button').hidden = false;

    if (kind === 'unconfigured') {
      title.textContent = 'Subscriptions are opening soon';
      detail.textContent = 'Billing is not switched on yet. The download is already available.';
      $('retry-button').hidden = true;
      return;
    }
    title.textContent = "We couldn't check your subscription";
    detail.textContent = MESSAGES.offline;
  }

  // ------------------------------------------------------------------ signed-in flow
  let lastEntitlement = null;

  /*
    Two things can ask for the account view at once: the sign-in handler, and the
    SIGNED_IN auth event that the same sign-in raises. Letting both run means two
    entitlement calls whose answers race, and the loser can overwrite a sign-out or a
    retry banner with stale state. So refreshes are de-duplicated: a second caller joins
    the one already in flight, and hands its intent over rather than dropping it.
  */
  let pendingIntent = null;
  let refreshInFlight = null;

  function requestAccountRefresh({ intent = null } = {}) {
    if (intent) pendingIntent = intent;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        await refreshAccountView();
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function refreshAccountView() {
    const intent = pendingIntent;
    pendingIntent = null;
    // A recovery link is mid-flight: the visitor must set a password before anything else.
    if (recoveryMode) return void showView('reset', { focus: currentView !== 'reset' });

    const { data } = await client.auth.getUser();
    const user = data?.user;
    if (!user) return void showSignedOut();

    $('account-email').textContent = user.email ?? '';
    showView('account', { focus: currentView !== 'account' });
    if (!storageIsPersistent) {
      setStatus("Your browser is blocking storage, so you'll be signed out when you close this tab.", 'info');
    }

    const result = await fetchEntitlement();

    if (result.state === 'signed_out') {
      await signOutLocally(MESSAGES.signed_out);
      return;
    }
    if (result.state === 'offline' || result.state === 'unconfigured') {
      renderSubscriptionProblem(result.state);
      return;
    }

    lastEntitlement = result.entitlement;
    renderSubscription(result.entitlement);

    // A remembered #subscribe/#billing intent is carried across the sign-in.
    if (intent === 'subscribe' && !result.entitlement.entitled) await startCheckout();
    else if (intent === 'billing') await openPortal();
  }

  function showSignedOut(view = 'signin') {
    lastEntitlement = null;
    showView(view);
  }

  async function signOutLocally(message) {
    // Local data goes regardless of whether the server call succeeds (contract C3).
    try { await client.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
    showSignedOut();
    if (message) setStatus(message, 'error');
  }

  // ------------------------------------------------------------------ checkout and portal
  async function startCheckout() {
    const button = $('subscribe-button');
    setPending(button, true, 'Opening checkout…');
    setFieldError('subscription-error', '');
    try {
      const token = await accessToken();
      if (!token) return void (await signOutLocally(MESSAGES.signed_out));

      const { status, body } = await callFunction('create-checkout-session', { method: 'POST', token });

      if (status === 200 && body?.url) {
        track('begin_checkout');
        location.assign(body.url);
        return;
      }
      if (status === 409) {
        // Already subscribed: re-read the truth and show the active card instead of an error.
        setStatus('You already have an active subscription.', 'info');
        await requestAccountRefresh();
        return;
      }
      if (status === 401) return void (await signOutLocally(MESSAGES.signed_out));
      if (status === 503) {
        setFieldError('subscription-error', 'Subscriptions are not switched on yet. Email Help@prop-layer.com.');
        return;
      }
      setFieldError('subscription-error', body?.message || MESSAGES.offline);
    } finally {
      setPending(button, false);
    }
  }

  async function openPortal() {
    const button = $('manage-button');
    setPending(button, true, 'Opening billing…');
    setFieldError('subscription-error', '');
    try {
      const token = await accessToken();
      if (!token) return void (await signOutLocally(MESSAGES.signed_out));

      const { status, body } = await callFunction('create-portal-session', { method: 'POST', token });

      if (status === 200 && body?.url) {
        location.assign(body.url);
        return;
      }
      if (status === 404) {
        // No Stripe customer: there is genuinely nothing to manage.
        button.hidden = true;
        setFieldError('subscription-error', 'There is no billing history on this account yet.');
        return;
      }
      if (status === 401) return void (await signOutLocally(MESSAGES.signed_out));
      setFieldError('subscription-error', body?.message || MESSAGES.offline);
    } finally {
      setPending(button, false);
    }
  }

  // ------------------------------------------------------------------ post-checkout polling
  const ACTIVATION_TIMEOUT_MS = 60_000;
  const ACTIVATION_INTERVAL_MS = 2000;

  async function awaitActivation() {
    setStatus('Activating your subscription…', 'info');
    const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await fetchEntitlement();
      if (result.state === 'signed_out') return void (await signOutLocally(MESSAGES.signed_out));

      if (result.state === 'ok') {
        lastEntitlement = result.entitlement;
        renderSubscription(result.entitlement);
        if (result.entitlement.entitled) {
          track('purchase');
          setStatus("You're all set. Open Prop Layer on your PC and sign in with this email.", 'success');
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, ACTIVATION_INTERVAL_MS));
    }

    setStatus(
      'Payment received — activation is taking longer than usual. Refresh in a minute or email Help@prop-layer.com.',
      'error'
    );
  }

  // ------------------------------------------------------------------ forms
  function wirePasswordToggles() {
    for (const button of document.querySelectorAll('[data-toggle-password]')) {
      button.addEventListener('click', () => {
        const input = $(button.dataset.togglePassword);
        if (!input) return;
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        button.textContent = reveal ? 'Hide' : 'Show';
        button.setAttribute('aria-pressed', String(reveal));
      });
    }
  }

  function wireViewLinks() {
    for (const link of document.querySelectorAll('[data-view-link]')) {
      link.addEventListener('click', event => {
        event.preventDefault();
        const view = link.dataset.viewLink;
        clearFieldErrors();
        setStatus('');
        location.hash = `#${view}`;
        showView(view);
      });
    }
  }

  $('signin-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    clearFieldErrors();
    setStatus('');
    $('resend-row').hidden = true;

    const button = $('signin-submit');
    setPending(button, true, 'Signing in…');
    try {
      const email = $('signin-email').value.trim();
      const { error } = await client.auth.signInWithPassword({ email, password: $('signin-password').value });
      if (error) {
        const described = describeAuthError(error);
        setFieldError('signin-error', described.message);
        $('resend-row').hidden = !described.notConfirmed;
        return;
      }
      $('signin-password').value = '';
      track('login');
      await requestAccountRefresh({ intent: takeIntent() });
    } finally {
      setPending(button, false);
    }
  });

  $('resend-confirmation').addEventListener('click', async event => {
    const button = event.currentTarget;
    setPending(button, true, 'Sending…');
    try {
      const email = $('signin-email').value.trim();
      if (!email) return void setFieldError('signin-error', 'Enter your email address first.');
      const { error } = await client.auth.resend({ type: 'signup', email });
      if (error) return void setFieldError('signin-error', describeAuthError(error).message);
      setFieldError('signin-error', '');
      setStatus('Confirmation email sent. Check your inbox.', 'success');
    } finally {
      setPending(button, false);
    }
  });

  $('signup-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    clearFieldErrors();
    setStatus('');

    const password = $('signup-password').value;
    if (password.length < 8) return void setFieldError('signup-error', 'Choose a password with at least 8 characters.');
    if (password !== $('signup-confirm').value) return void setFieldError('signup-error', 'The two passwords do not match.');

    const button = $('signup-submit');
    setPending(button, true, 'Creating your account…');
    try {
      const { error } = await client.auth.signUp({
        email: $('signup-email').value.trim(),
        password,
        options: { emailRedirectTo: `${redirectOrigin}/account.html` }
      });
      if (error) return void setFieldError('signup-error', describeAuthError(error).message);

      // Never reveal whether the address already had an account: the message is the same
      // either way, and Supabase's response is deliberately identical too.
      $('signup-password').value = '';
      $('signup-confirm').value = '';
      track('sign_up');
      showView('signin');
      setStatus('Check your inbox to confirm your email, then sign in.', 'success');
    } finally {
      setPending(button, false);
    }
  });

  $('forgot-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    clearFieldErrors();

    const button = $('forgot-submit');
    setPending(button, true, 'Sending…');
    try {
      const email = $('forgot-email').value.trim();
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: `${redirectOrigin}/account.html#reset`
      });
      // Rate limiting is worth telling the visitor about; anything else must not reveal
      // whether the address exists, so the message is the same for success and failure.
      if (error && Number(error.status) === 429) {
        return void setFieldError('forgot-error', MESSAGES.rate_limited);
      }
      showView('signin');
      setStatus("If an account exists, we've sent a reset link.", 'success');
    } finally {
      setPending(button, false);
    }
  });

  $('reset-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    clearFieldErrors();

    const password = $('reset-password').value;
    if (password.length < 8) return void setFieldError('reset-error', 'Choose a password with at least 8 characters.');
    if (password !== $('reset-confirm').value) return void setFieldError('reset-error', 'The two passwords do not match.');

    const button = $('reset-submit');
    setPending(button, true, 'Saving…');
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) return void setFieldError('reset-error', describeAuthError(error).message);
      $('reset-password').value = '';
      $('reset-confirm').value = '';
      setStatus('Your password has been changed.', 'success');
      await requestAccountRefresh();
    } finally {
      setPending(button, false);
    }
  });

  $('sign-out').addEventListener('click', async event => {
    const button = event.currentTarget;
    setPending(button, true, 'Signing out…');
    try {
      await signOutLocally(null);
      setStatus("You've been signed out.", 'info');
    } finally {
      setPending(button, false);
    }
  });

  $('subscribe-button').addEventListener('click', () => void startCheckout());
  $('manage-button').addEventListener('click', () => void openPortal());
  $('retry-button').addEventListener('click', () => void requestAccountRefresh());

  wirePasswordToggles();
  wireViewLinks();

  // ------------------------------------------------------------------ URL and auth events
  /** Supabase reports email-link failures in the URL fragment, e.g. `#error=access_denied`. */
  function linkErrorFromUrl() {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(location.search);
    const code = fragment.get('error_code') ?? query.get('error_code');
    const error = fragment.get('error') ?? query.get('error');
    if (!code && !error) return null;
    const description = fragment.get('error_description') ?? query.get('error_description') ?? '';
    return { code: code ?? error, description };
  }

  function hashIntent() {
    const hash = location.hash.replace(/^#/, '').split('&')[0];
    return VIEWS.includes(hash) || hash === 'subscribe' || hash === 'billing' ? hash : null;
  }

  /** Drops query/fragment noise from the address bar without reloading. */
  function cleanUrl(hash = '') {
    try {
      history.replaceState(null, '', location.pathname + hash);
    } catch { /* a blocked history API must not break the page */ }
  }

  /*
    Read from the URL synchronously, before any async work: a recovery link carries both a
    usable session and `type=recovery`, and supabase-js raises SIGNED_IN next to
    PASSWORD_RECOVERY. Deciding this up front stops the account view from racing ahead of
    the "choose a new password" form.
  */
  let recoveryMode = (() => {
    const fragment = location.hash.replace(/^#/, '');
    if (fragment.split('&')[0] === 'reset') return true;
    return new URLSearchParams(fragment).get('type') === 'recovery';
  })();

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      cleanUrl('#reset');
      showView('reset');
      setStatus('');
      return;
    }
    if (event === 'SIGNED_OUT') {
      if (currentView === 'account') showSignedOut();
      return;
    }
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session && !recoveryMode) {
      if (SIGNED_OUT_VIEWS.includes(currentView) || currentView === 'loading') {
        void requestAccountRefresh({ intent: takeIntent() });
      }
    }
  });

  async function start() {
    const linkError = linkErrorFromUrl();
    if (linkError) {
      cleanUrl();
      const detail = $('link-error-detail');
      detail.textContent = /expired/i.test(linkError.code + linkError.description)
        ? 'That email link has expired. Links are valid for a short time only — ask for a new one and it will arrive in a moment.'
        : 'That email link could not be used. It may already have been opened. Ask for a new one and it will arrive in a moment.';
      showView('link-error');
      return;
    }

    const intent = hashIntent();

    const { data } = await client.auth.getSession();
    const signedIn = Boolean(data?.session);

    if (!signedIn) {
      if (intent === 'subscribe' || intent === 'billing') {
        rememberIntent(intent);
        showView('signin');
        setStatus(intent === 'subscribe'
          ? 'Sign in or create an account to subscribe.'
          : 'Sign in to manage your billing.', 'info');
        return;
      }
      showView(SIGNED_OUT_VIEWS.includes(intent) ? intent : 'signin', { focus: Boolean(intent) });
      return;
    }

    if (recoveryMode) {
      showView('reset');
      return;
    }

    const checkout = new URLSearchParams(location.search).get('checkout');
    if (checkout) {
      // The query string is noise once read, and must not survive a refresh.
      cleanUrl(checkout === 'canceled' ? '#subscribe' : '');
      await requestAccountRefresh();
      if (checkout === 'success') await awaitActivation();
      else setStatus("Checkout canceled — you weren't charged.", 'info');
      return;
    }

    await requestAccountRefresh({ intent: intent === 'subscribe' || intent === 'billing' ? intent : null });
  }

  void start();

  // Exposed for the browser suite only: it asserts on rendered state, never on internals.
  window.__PROPLAYER_ACCOUNT__ = {
    get view() { return currentView; },
    get entitlement() { return lastEntitlement; },
    get storageIsPersistent() { return storageIsPersistent; }
  };
})();
