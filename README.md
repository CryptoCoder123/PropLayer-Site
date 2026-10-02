# Prop Layer website

A static HTML, CSS and JavaScript site for GitHub Pages. No build step or production packages are required. The existing `CNAME` remains `prop-layer.com`.

## Preview

Run `npm run dev`, then open <http://localhost:4173>. The preview server binds to localhost only. The website can also be hosted by any static web server.

## What is implemented

- A responsive visual system built around the supplied, unmodified blue logo and original sports artwork.
- The opening pairs oversized editorial typography on the left with looping AI-generated concept footage (`aiBaseball.mp4`, labeled as such) on the right; on narrow screens the footage becomes a card below the copy. The footage pauses off-screen and stays on its poster frame under reduced motion. A four-figure value band follows, then a layered scene frame and the compact Prop Layer panel. Sport-specific lighting, restrained pointer-driven depth and user-triggered image transitions respond to the visitor. Motion respects reduced-motion preferences and the scene remains steady on touch devices.
- Eight original basketball, football, baseball and hockey illustrations keep their embedded player badges intact. The Game and Player 1 menus load the corresponding player, team, image and badge values. The panel's league buttons switch sports. Clicking the image, Focus badge, or the panel arrow zooms into the original badge. Arrow keys switch between the two players in the active sport.
- A compact Game Info panel, minimize/restore, mobile navigation between scene and controls, and a three-step orientation. The separate lower explorer, scene thumbnails, Settings tab, save/share controls and preference storage have been removed. Previously shared scene links still resolve with validated values. No account service or new integration is required.
- Early-access and partnership forms using the existing Formspree endpoint, `mpqorvvk`. Submissions include a `request_type` and distinct subject. Validation, pending, confirmed success, timeout and error states are implemented. Failure preserves entered details; email is an alternative.
- The sports section uses the original five-sport concept collage; its credit notes that soccer is shown as planned.
- Shared navigation, footer and typography on the partnership, privacy, terms, brand and 404 pages. Existing terms and app privacy copy are retained, with a factual website-data addition to privacy.

## Product truth

The owner confirmed on October 2, 2026 that basketball, football, baseball and hockey are working. Windows alpha wording is retained; soccer remains planned. Pricing is unannounced. The owner also supplied a screenshot of the software operating: a compact player-name/stat badge above an athlete, with a separate Game Info panel for sport, game, teams and player selection. This reference supersedes the old NBA/MLB-only website copy.

The website demo uses the repository’s original concept artwork, with its existing badges and fictional players. Badge values in the interactive Game Info panel are transcribed from those images. The Game selector loads sample scenes, not actual fixtures; opponent teams and a second player are not invented. The two Marcus Hale artworks use distinct IDs so baseball and hockey cannot be confused. There are no invented season-stat tables, replacement overlays, live data feeds or simulated tracking. Inspecting a badge zooms into the original artwork. Pointer movement tilts only the website scene frame; it does not demonstrate athlete tracking. The owner's panel screenshot informs a clearly labeled interactive web recreation, not a product capture. No service or API keys are required for the panel demo.

## Project structure

- `index.html`: interactive opening, Game Info panel, FAQ and early-access form.
- `partners.html`: partnership inquiry flow.
- `assets/site.css`: shared visual tokens, component styles and responsive layout.
- `assets/experience.css`: immersive opening, scene frame, compact panel and responsive image layouts.
- `assets/site.js`: navigation, form submission, artwork metadata, synchronized scene/panel controls, motion and walkthrough.
- `assets/newAssets/`: original supplied logo and concept illustrations. These files are unchanged.
- `assets/fonts/`: locally hosted, Latin-subset Barlow Condensed and Manrope WOFF fonts; SIL OFL licenses included. Fonts originate from the Google Fonts distribution. No font-service requests are needed at runtime.
- `tools/serve.cjs`: local preview server.
- `tools/browser-check.cjs`: browser interaction and responsive verification.

## Verification

Install development-only tools with `npm ci`. With `npm run dev` running in another terminal, run `npm test`. Tests use an installed Google Chrome through Playwright. Screenshots and a verification report are saved to ignored `artifacts/`.

Tests cover the removal of the old controls, the four supported sports, all eight player/team/image/badge mappings, panel sport buttons, the value band and collage, uncropped artwork, badge inspection, keyboard navigation, minimize/restore, mobile scene/panel navigation, old demo links, blocked storage, pointer depth, walkthrough focus, reduced motion, six responsive widths, local destinations, no-JavaScript form fallback, and both forms’ accepted/failed responses. Analytics and form calls are intercepted in tests. **No real lead submissions are sent.**

## External services and launch checks

The existing Formspree endpoint and Google Analytics tag (`G-Y0S7K0W3W5`) are preserved. No new service keys are needed. Confirm Formspree is active and its recipient delivery works in the owner's dashboard before publishing; the repository and browser tests cannot verify inbox delivery. The custom analytics event records only `lead_type`, never entered contact details. Publishing is not performed by the local preview or tests.

Use an actual alpha recording, if supplied later, with a clear product-demo label. There is currently no video asset or application backend in this repository.
