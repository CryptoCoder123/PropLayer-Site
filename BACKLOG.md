# PropLayer Site — Backlog

_Refreshed: 2026-05-19 against live `origin/main` @ 2bf0c33._
_See [REVIEW.md](REVIEW.md) for the audit this was built from._

> **Next session — pick up here:** tame the splash screen (item 1 below) — `sessionStorage` gate so it shows once per session, click-to-skip, shorten to ~2 s, and add `prefers-reduced-motion` (item 2). Self-contained, highest-value. Repo is in sync at `2bf0c33`.

## Done since last backlog (now live)

- ✅ Mobile fixes shipped (PRs #3, #4)
- ✅ Mobile hero carousel restored (was hidden) + touch-swipe + off-screen pause
- ✅ Google Analytics (GA4) added to all pages
- ✅ Animated splash/intro screen

## Start here (highest value)

1. **Tame the splash screen.** It currently locks scroll for ~4.7 s on *every* load. Gate with `sessionStorage` (show once per session), add click-to-skip, shorten to ~2 s. Biggest conversion risk on the page right now.
2. **Add `prefers-reduced-motion` support** so the splash bounce/pulse is disabled for motion-sensitive users.
3. **Add a favicon** (root `favicon.svg`/`.ico` + `<link rel="icon">` on all three pages). The splash logo SVG is right there to reuse.

## Quick wins (each ≤ 1 hour)

- **Open Graph + Twitter Card meta tags** on `index.html` (need a 1200×630 `og:image`) so shared links preview properly.
- **Decide on `logo.html`** — keep it out of the public deploy or confirm it's meant to be live.
- **Reconcile the two greens** — splash `#72ff54` vs token `--green #4ade80`. Pick one or name the splash green.
- **Fix the fake "$19.99" button** — clear "regular price after launch" label or remove.
- **robots.txt + sitemap.xml + 404.html.**
- **Carousel focus ring** for keyboard users.

## Bigger pieces

- **Compress demo videos** (39 MB / 19 MB → target < 10 MB each); lazy-load the second one.
- **Extract CSS to `assets/site.css`** when styles are next touched (~520 lines inline now).
- **Verify GA4 is recording** — check the Realtime view after a deploy; confirm waitlist submits show as an event (consider a custom `gtag('event', ...)` on form success).

## Product/content questions (not code)

- "$9.99 early-access / $19.99 standard" — still the plan?
- "Now in Beta" badge — still accurate, or "Early Access" / "Coming Soon"?
- "More sports coming soon" — any timing to commit to?
- BYOK note — anything to update re: latest Anthropic Claude API model/pricing?
