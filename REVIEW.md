# PropLayer Site — Review

_Review date: 2026-05-19 (refreshed against live `origin/main` @ 2bf0c33)_
_Reviewer: Claude_

## 1. Snapshot

- **Project**: Marketing/landing site for **PropLayer** — a desktop overlay that puts live NBA player stats and prop odds on top of any sports stream. Pre-launch, waitlist-only.
- **Stack**: Plain HTML/CSS/JS. No build step. No framework. No tests.
- **Files**: [index.html](index.html) (~1030 lines), [privacy.html](privacy.html), [terms.html](terms.html), [logo.html](logo.html) (logo design scratch page), [assets/](assets/) (player PNG/WebP + 2 demo MP4s, ~58 MB).
- **Hosting**: GitHub Pages, custom domain `prop-layer.com` ([CNAME](CNAME)).
- **Waitlist**: Formspree (form ID `mpqorvvk`).
- **Analytics**: Google Analytics 4, tag `G-Y0S7K0W3W5`, on all three public pages.
- **Branches**: local `main`, `updates`, and `origin/main` all in sync.

## 2. What landed since the last review (now live)

The mobile fixes and three follow-up commits (`intro`, `img carousel for mobile`, `img carousel`) are merged and deployed. Notable additions:

- **Animated splash/intro screen** — full-screen `#splash` overlay: an SVG "layer" logo drops in with a bounce, a `+100` badge pops, a glowing progress bar fills, then fades out after ~3.8 s. Scroll is locked while it shows.
- **GA4 analytics** added (was a backlog item — done).
- **Mobile hero carousel restored** — previously `display:none` below 900 px; now a 360 px-wide 3/4 card.
- **Carousel upgrades** — pauses when scrolled out of view (IntersectionObserver) + touch-swipe support.

## 3. Issues found

### High priority
- **Splash screen blocks content for ~4.7 s on every visit** ([index.html:512-630](index.html#L512-L630)). It replays on *every* page load, including return visitors, with no skip/click-to-dismiss. For a marketing page trying to convert, ~4.7 s of locked scroll before the hero is a real bounce risk. Recommend: gate it with `sessionStorage` so it shows once per session, add click-to-skip, and shorten to ~2 s.
- **No `prefers-reduced-motion` handling** for the splash bounce/pulse animations ([index.html:564-586](index.html#L564-L586)). Users with motion sensitivity get the full drop-bounce. Add a media query that disables or instantly resolves the splash.
- **No favicon** — `<link rel="icon">` still missing on all pages.

### Medium priority
- **Splash green is off-palette** — splash uses `#72ff54` ([index.html:530-562](index.html#L530-L562)) while the site's design-token green is `--green: #4ade80` ([index.html:16](index.html#L16)). Two different greens. Pick one (or add the splash green as a named token).
- **`logo.html` committed to the repo root** ([logo.html](logo.html)) — looks like a design scratch/preview page. It's publicly reachable at prop-layer.com/logo.html. Either move it out of the deploy path or confirm it's intentional.
- **SEO still thin** — only `<title>` + `<meta name="description">`. Missing Open Graph / Twitter Card tags (link previews look broken when shared), `<link rel="canonical">`, `robots.txt`, `sitemap.xml`.
- **Misleading "Standard — $19.99" pseudo-button** ([index.html](index.html), pricing section) — a `<div class="btn">` styled like a CTA but `cursor:default`, 55% opacity. Reads as a broken link. Make it a clear "regular price after launch" label or remove.
- **Demo videos are heavy** — `assets/demo.mp4` (39 MB) + `assets/demo2.mp4` (19 MB), both autoplay. Consider lazy-loading the second and re-encoding to < 10 MB each.

### Low priority / polish
- **Inline styles scattered** in [index.html](index.html) (hero eyebrow, pricing button, footer logo, etc.). Worth one cleanup pass; will matter more if CSS is ever extracted.
- **Carousel dots have no focus ring** — keyboard users can't see focus.
- **No 404 page** for GitHub Pages.

## 4. What's working well

- Mobile experience meaningfully improved (carousel visible + swipeable, off-screen pause saves cycles).
- Analytics now in place — conversion is measurable.
- Tight, product-first copy.
- Design tokens, WebP/PNG `<picture>` fallback, honeypot anti-spam all still solid.
- Splash is genuinely slick — the criticism is about gating/duration, not craft.
