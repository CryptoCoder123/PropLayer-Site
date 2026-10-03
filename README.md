# Prop Layer website

A static HTML, CSS and JavaScript site for GitHub Pages. No build step or production packages are required. The existing `CNAME` remains `prop-layer.com`.

Accounts and subscriptions are handled by a Supabase project and Stripe, defined in this repository under `supabase/` and documented in [docs/ACCOUNTS_AND_BILLING.md](docs/ACCOUNTS_AND_BILLING.md). No server is added to the site itself: the new pages are static too, and the Supabase browser library is vendored into `assets/vendor/` so there are still no runtime requests to a CDN.

## Preview

Run `npm run dev`, then open <http://localhost:4173>. The preview server binds to localhost only. The website can also be hosted by any static web server.

## What is implemented

- A responsive visual system built around the supplied, unmodified blue logo and original sports artwork.
- The opening pairs oversized editorial typography on the left with looping AI-generated concept footage (`aiBaseball.mp4`, labeled as such) on the right; on narrow screens the footage becomes a card below the copy. The footage pauses off-screen and stays on its poster frame under reduced motion. A three-part value band follows, then a layered scene frame and the compact Prop Layer panel. Sport-specific lighting, restrained pointer-driven depth and user-triggered image transitions respond to the visitor. Motion respects reduced-motion preferences and the scene remains steady on touch devices.
- Eight original basketball, football, baseball and hockey illustrations keep their embedded player badges intact. The Game and Player 1 menus load the corresponding player, team, image and badge values. The panel's league buttons switch sports. Clicking the image, Focus badge, or the panel arrow zooms into the original badge. Arrow keys switch between the two players in the active sport.
- A compact Game Info panel, minimize/restore, mobile navigation between scene and controls, and a three-step orientation. The separate lower explorer, scene thumbnails, Settings tab, save/share controls and preference storage have been removed. Previously shared scene links still resolve with validated values.
- Accounts and billing: `account.html` handles sign-up, sign-in, email confirmation, password reset, subscribing through Stripe Checkout and managing or cancelling through the Stripe Customer Portal. `download.html` is a public download page that reads the latest GitHub release. One endpoint, `GET /functions/v1/entitlement`, answers "may this account run Prop Layer?" for both the website and the desktop app. See [docs/ACCOUNTS_AND_BILLING.md](docs/ACCOUNTS_AND_BILLING.md).
- Product-updates and partnership forms using the existing Formspree endpoint, `mpqorvvk`. Submissions include a `request_type` and distinct subject. Validation, pending, confirmed success, timeout and error states are implemented. Failure preserves entered details; email is an alternative.
- The sports section uses the original five-sport concept collage; its credit notes that soccer is shown as planned.
- Launch splash from the previous site (layered mark, +100, progress bar, about 4.7 seconds) plays on each load of the home page and is skipped under reduced motion.
- Shared navigation, footer and typography on the partnership, privacy, terms, brand and 404 pages. Existing terms and app privacy copy are retained, with a factual website-data addition to privacy.

## Product truth

The owner confirmed on October 2, 2026 that basketball, football, baseball and hockey are working. Windows alpha wording is retained; soccer remains planned. Prop Layer is sold as one monthly subscription; the price lives in `assets/config.js` (`priceDisplay`) and in the Stripe price with lookup key `proplayer_monthly`, and is written there by `npm run billing:setup`. The owner also supplied a screenshot of the software operating: a compact player-name/stat badge above an athlete, with a separate Game Info panel for sport, game, teams and player selection. This reference supersedes the old NBA/MLB-only website copy.

The website demo uses the repository’s original concept artwork, with its existing badges and fictional players. Badge values in the interactive Game Info panel are transcribed from those images. The Game selector loads sample scenes, not actual fixtures; opponent teams and a second player are not invented. The two Marcus Hale artworks use distinct IDs so baseball and hockey cannot be confused. There are no invented season-stat tables, replacement overlays, live data feeds or simulated tracking. Inspecting a badge zooms into the original artwork. Pointer movement tilts only the website scene frame; it does not demonstrate athlete tracking. The owner's panel screenshot informs a clearly labeled interactive web recreation, not a product capture. No service or API keys are required for the panel demo. In the application itself, Claude-based jersey identification uses the user's own Anthropic API key and live odds use the user's own The Odds API key; both features are optional.

## Project structure

- `index.html`: interactive opening, Game Info panel, pricing, FAQ and the product-updates form.
- `account.html`, `assets/account.js`: sign-up, sign-in, password reset, subscription and billing.
- `download.html`, `assets/download.js`: public download of the latest GitHub release.
- `assets/config.js`: public configuration (contract PL-ACCOUNT-1, C2). Never holds a secret.
- `assets/analytics.js`: the GA4 bootstrap as a file, so the new pages need no inline script.
- `assets/vendor/`: the pinned, vendored `@supabase/supabase-js` UMD build and its MIT licence. Regenerate with `npm run vendor:supabase`.
- `contract/`: the shared PL-ACCOUNT-1 schema, fixtures and fingerprint table. Byte-identical to the desktop repository's copy.
- `supabase/`: the migration, `config.toml`, the pgTAP RLS suite, and the four Edge Functions with their Deno tests.
- `scripts/`: vendoring, deployment, Stripe setup, configuration checks and the end-to-end billing test.
- `partners.html`: partnership inquiry flow.
- `assets/site.css`: shared visual tokens, component styles and responsive layout.
- `assets/experience.css`: immersive opening, scene frame, compact panel and responsive image layouts.
- `assets/site.js`: navigation, form submission, artwork metadata, synchronized scene/panel controls, motion and walkthrough.
- `assets/newAssets/`: original supplied logo and concept illustrations. These files are unchanged.
- `assets/fonts/`: locally hosted, Latin-subset Barlow Condensed and Manrope WOFF fonts; SIL OFL licenses included. Fonts originate from the Google Fonts distribution. No font-service requests are needed at runtime.
- `tools/serve.cjs`: local preview server.
- `tools/browser-check.cjs`: browser interaction and responsive verification.
- `tools/account-check.cjs`: the account and download suite, with every backend call mocked.
- `tools/contract-check.cjs`: contract fingerprints and schema validation, without a browser.

## Verification

Install development-only tools with `npm ci`. With `npm run dev` running in another terminal, run `npm test`. Tests use an installed Google Chrome through Playwright; set `PLAYWRIGHT_CHANNEL=chromium` to use Playwright's bundled build instead. Screenshots and verification reports are saved to ignored `artifacts/`.

| Command | Covers |
|---|---|
| `npm test` | Contract fingerprints, the site suite and the account/download suite |
| `npm run test:functions` | Deno unit tests for the four Edge Functions and the entitlement decision |
| `npm run test:db` | The pgTAP row-level-security suite (needs Docker) |
| `npm run test:db:psql` | The same assertions against a plain PostgreSQL 15+ instance |
| `npm run check:config` | Leaked secrets and unfilled placeholders in tracked files |
| `npm run e2e:billing` | The real flow in Stripe test mode, through a test clock |

Tests cover the removal of the old controls, the four supported sports, all eight player/team/image/badge mappings, panel sport buttons, the value band and collage, uncropped artwork, badge inspection, keyboard navigation, minimize/restore, mobile scene/panel navigation, old demo links, blocked storage, pointer depth, walkthrough focus, reduced motion, six responsive widths, local destinations, no-JavaScript form fallback, and both forms’ accepted/failed responses. Analytics and form calls are intercepted in tests. **No real lead submissions are sent.**

The account and download suite additionally covers the not-configured state, sign-up, every sign-in error from the contract, password reset and recovery links, each subscription card, checkout and portal redirects, post-checkout polling and its timeout, a `401` refresh-and-retry, offline and `5xx` handling, blocked storage, sign-out, the download page against a mocked release and each of its failure modes, and no horizontal overflow from 360 to 1440 px. Supabase Auth, the Edge Functions, GitHub and Stripe are all intercepted; **no real service is contacted and no payment is made.**

## External services and launch checks

The existing Formspree endpoint and Google Analytics tag (`G-Y0S7K0W3W5`) are preserved. Accounts and billing add two services, Supabase and Stripe, plus GitHub Releases for the installer. Their public values live in `assets/config.js`; every secret lives only in Supabase Edge Function secrets or the operator's shell. `npm run check:config` fails if a secret ever reaches a tracked file. Confirm Formspree is active and its recipient delivery works in the owner's dashboard before publishing; the repository and browser tests cannot verify inbox delivery. The custom analytics event records only `lead_type`, never entered contact details. Publishing is not performed by the local preview or tests.

Use an actual alpha recording, if supplied later, with a clear product-demo label.

The remaining launch steps that need the owner — choosing the price, creating the Supabase and Stripe accounts, setting up SMTP, creating the public releases repository, and reviewing the new terms and privacy sections — are listed in order in [docs/ACCOUNTS_AND_BILLING.md](docs/ACCOUNTS_AND_BILLING.md).
