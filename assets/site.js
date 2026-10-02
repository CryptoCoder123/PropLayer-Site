/* Shared site behavior and original-art scene explorer. No live sports feed. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const menu = $('.menu-toggle');
  const links = $('#nav-links');
  function closeMenu() {
    if (!menu) return;
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open navigation');
    links.classList.remove('is-open');
  }
  menu?.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    links.classList.toggle('is-open', open);
  });
  $$('.nav-links a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') {
      closeMenu(); menu.focus();
    }
  });
  document.addEventListener('click', event => {
    if (menu && !event.target.closest('.site-header')) closeMenu();
  });
  matchMedia('(min-width:681px)').addEventListener('change', closeMenu);

  // Native form actions still work if JavaScript is unavailable.
  $$('form[data-inquiry]').forEach(form => {
    let pending = false;
    const status = $('.form-status', form);
    const button = $('button[type=submit]', form);
    const originalButton = button.innerHTML;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending || !form.reportValidity()) return;
      pending = true;
      button.disabled = true;
      button.textContent = 'Sending your request…';
      form.setAttribute('aria-busy', 'true');
      status.dataset.state = 'sending';
      status.textContent = 'Connecting securely…';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(form.action, {
          method: 'POST', headers: { Accept: 'application/json' },
          body: new FormData(form), signal: controller.signal
        });
        if (!response.ok) throw new Error('Request not accepted');
        status.dataset.state = 'success';
        status.textContent = form.dataset.inquiry === 'partnership'
          ? 'Your partnership inquiry was sent. The Prop Layer team will review your message and reply by email.'
          : 'Your request was sent. Watch your inbox for news from Prop Layer. Alpha access is coordinated by the team.';
        form.reset();
        $('#platform-note')?.setAttribute('hidden', '');
        if (typeof window.gtag === 'function') window.gtag('event', 'generate_lead', { lead_type: form.dataset.inquiry });
      } catch (error) {
        status.dataset.state = 'error';
        status.textContent = error.name === 'AbortError'
          ? 'We could not confirm delivery in time. Your details are still here. Try again or email Help@prop-layer.com.'
          : 'Your request could not be confirmed. Your details are still here. Please try again or email Help@prop-layer.com.';
      } finally {
        clearTimeout(timeout);
        pending = false;
        button.disabled = false;
        button.innerHTML = originalButton;
        form.removeAttribute('aria-busy');
      }
    });
  });
  $('#access-platform')?.addEventListener('change', event => {
    $('#platform-note').hidden = event.target.value === 'Windows';
  });
  $$('.sport-list details').forEach(detail => detail.addEventListener('toggle', () => {
    if (detail.open) $$('.sport-list details').forEach(other => { if (other !== detail) other.open = false; });
  }));

  // Each value below is transcribed from the supplied concept artwork.
  // The image's existing badge is preserved; the website adds no badge over it.
  const explorer = $('[data-explorer]');
  if (!explorer) return;
  const scenes = {
    devon: { name: 'Devon Kier', team: 'Silverdale Phantoms', sport: 'basketball', file: 'basketball1.webp', metric: 'Points', line: '24.5', odds: '+135', portrait: false, badge: [.35, .024, .292, .195] },
    kenji: { name: 'Kenji Blake', team: 'Crown Heights Titans', sport: 'basketball', file: 'basketball2.webp', metric: 'Points', line: '26.5', odds: '+140', portrait: true, badge: [.345, .029, .352, .105] },
    darius: { name: 'Darius Knox', team: 'Harbor Point Outlaws', sport: 'football', file: 'football1.webp', metric: 'Rushing yards', line: '86.5', odds: '+155', portrait: false, badge: [.303, .018, .353, .166] },
    isaiah: { name: 'Isaiah Rowe', team: 'River State Thunder', sport: 'football', file: 'football2.webp', metric: 'Passing yards', line: '276.5', odds: '+160', portrait: true, badge: [.284, .057, .462, .113] },
    malik: { name: 'Malik Dorsey', team: 'Bayfront Admirals', sport: 'baseball', file: 'baseball1.webp', metric: 'Home runs', line: '0.5', odds: '+230', portrait: false, badge: [.319, .029, .154, .123] },
    marcus: { name: 'Marcus Hale', team: 'Golden Arrows', sport: 'baseball', file: 'baseball2.webp', metric: 'Home runs', line: '0.5', odds: '+235', portrait: true, badge: [.29, .084, .305, .073] },
    marcus_hockey: { name: 'Marcus Hale', team: 'Ironvale Phantoms', sport: 'hockey', file: 'hockey1.webp', metric: 'Shots on goal', line: '4.5', odds: '+145', portrait: false, badge: [.445, .038, .219, .139] },
    luka: { name: 'Luka Vasilev', team: 'Frost Guard', sport: 'hockey', file: 'hockey2.webp', metric: 'Shots on goal', line: '3.5', odds: '+205', portrait: true, badge: [.495, .039, .342, .074] }
  };
  const state = { player: 'devon', detail: 'scene' };
  // Previously shared links still open their original player; no preference storage.
  const params = new URLSearchParams(location.search);
  if (['1', '2'].includes(params.get('view'))) {
    if (Object.hasOwn(scenes, params.get('player'))) state.player = params.get('player');
    if (params.get('detail') === 'badge') state.detail = 'badge';
  }
  const canvas = $('#explorer-canvas');
  const picture = $('#explorer-image');
  const gameSelect = $('#panel-game');
  const playerSelect = $('#panel-player');
  const frame = $('#arena-window');
  const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)');
  const finePointer = matchMedia('(hover:hover) and (pointer:fine)');
  const leagues = { basketball: 'NBA', football: 'NFL', baseball: 'MLB', hockey: 'NHL' };
  let imageAnimation;

  function fitImage() {
    const scene = scenes[state.player];
    const width = scene.portrait ? 941 : 1672;
    const height = scene.portrait ? 1672 : 941;
    const areaWidth = canvas.clientWidth;
    const areaHeight = canvas.clientHeight;
    let scale = Math.min(areaWidth / width, areaHeight / height);
    let x = (areaWidth - width * scale) / 2;
    let y = (areaHeight - height * scale) / 2;
    if (state.detail === 'badge') {
      const [bx, by, bw, bh] = scene.badge;
      scale = Math.min(areaWidth * .8 / (bw * width), areaHeight * .52 / (bh * height));
      x = areaWidth / 2 - (bx + bw / 2) * width * scale;
      y = areaHeight * .14 - by * height * scale;
    }
    picture.style.width = `${width}px`;
    picture.style.height = `${height}px`;
    picture.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }
  function render() {
    const scene = scenes[state.player];
    const ids = Object.keys(scenes).filter(id => scenes[id].sport === scene.sport);
    explorer.dataset.sport = scene.sport;
    explorer.dataset.detail = state.detail;
    canvas.dataset.league = leagues[scene.sport];
    if (!picture.src.endsWith(scene.file)) {
      picture.src = `assets/newAssets/${scene.file}`;
      imageAnimation?.cancel();
      if (!reducedMotion.matches) imageAnimation = picture.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    }
    picture.alt = `Original ${scene.sport} illustration: ${scene.name}, ${scene.team}. Badge: ${scene.odds}, ${scene.metric} O/U ${scene.line}. Fictional player and sample values.`;
    $('#scene-player').textContent = scene.name;
    $('#scene-team').textContent = scene.team;
    $('#scene-league').textContent = leagues[scene.sport];
    $('#panel-team').textContent = scene.team;
    $('#badge-metric').textContent = scene.metric;
    $('#badge-line').textContent = `O/U ${scene.line}`;
    $('#badge-odds').textContent = scene.odds;
    if (gameSelect.dataset.sport !== scene.sport) {
      gameSelect.dataset.sport = scene.sport;
      gameSelect.replaceChildren(...ids.map(id => new Option(`${scenes[id].team} · sample scene`, id)));
      playerSelect.replaceChildren(...ids.map(id => new Option(scenes[id].name, id)));
    }
    gameSelect.value = playerSelect.value = state.player;
    gameSelect.title = gameSelect.selectedOptions[0].textContent;
    const zoomed = state.detail === 'badge';
    const inspectLabel = zoomed ? `Show ${scene.name}’s full scene` : `Inspect ${scene.name}’s original badge`;
    [canvas, $('#panel-inspect'), $('#focus-badge')].forEach(button => {
      button.setAttribute('aria-pressed', String(zoomed));
      button.setAttribute('aria-label', inspectLabel);
    });
    $('#focus-label').textContent = zoomed ? 'Back to game' : 'Focus badge';
    $('#panel-inspect').title = zoomed ? 'Return to the full scene' : 'Inspect the selected player’s badge';
    $('.arena-canvas-hint').hidden = zoomed;
    $('#panel-connection').textContent = `${scene.name} connected`;
    $$('button[data-sport]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sport === scene.sport)));
    fitImage();
  }
  function selectPlayer(id) {
    if (!Object.hasOwn(scenes, id)) return;
    state.player = id;
    state.detail = 'scene';
    $('#scene-error').hidden = true;
    render();
  }
  $$('button[data-sport]').forEach(button => button.addEventListener('click', () => {
    if (scenes[state.player].sport !== button.dataset.sport) selectPlayer(Object.keys(scenes).find(id => scenes[id].sport === button.dataset.sport));
  }));
  [gameSelect, playerSelect].forEach(select => select.addEventListener('change', () => selectPlayer(select.value)));
  function toggleDetail() {
    state.detail = state.detail === 'scene' ? 'badge' : 'scene'; render();
  }
  [canvas, $('#panel-inspect'), $('#focus-badge')].forEach(button => button.addEventListener('click', toggleDetail));
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const ids = Object.keys(scenes).filter(id => scenes[id].sport === scenes[state.player].sport);
    selectPlayer(ids[(ids.indexOf(state.player) + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length]);
  });
  new ResizeObserver(fitImage).observe(canvas);
  picture.addEventListener('error', () => {
    $('#scene-error').textContent = 'This scene could not load. Choose another player or reload the page.';
    $('#scene-error').hidden = false;
  });
  picture.addEventListener('load', () => { $('#scene-error').hidden = true; });
  $('#panel-collapse').addEventListener('click', event => {
    const button = event.currentTarget;
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? 'Minimize demo panel' : 'Expand demo panel');
    $('span', button).textContent = expanded ? '−' : '+';
    $('#panel-content').hidden = !expanded;
  });
  function reveal(element, focusTarget) {
    element.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
    focusTarget.focus({ preventScroll: true });
  }
  $('#open-panel').addEventListener('click', () => {
    if ($('#panel-content').hidden) $('#panel-collapse').click();
    reveal($('#app-panel'), $('.app-sports button[aria-pressed=true]'));
  });
  $('#panel-show-scene').addEventListener('click', () => reveal(canvas, canvas));

  // Small pointer-driven depth on the scene frame, never automatic camera motion.
  let pointerFrame = 0;
  frame.addEventListener('pointermove', event => {
    if (reducedMotion.matches || !finePointer.matches) return;
    cancelAnimationFrame(pointerFrame);
    const bounds = frame.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - .5;
    const y = (event.clientY - bounds.top) / bounds.height - .5;
    pointerFrame = requestAnimationFrame(() => {
      frame.style.setProperty('--turn-x', `${-y * 1.5}deg`);
      frame.style.setProperty('--turn-y', `${x * 1.5}deg`);
      frame.style.setProperty('--light-x', `${(x + .5) * 100}%`);
    });
  });
  function clearDepth() {
    cancelAnimationFrame(pointerFrame);
    frame.style.removeProperty('--turn-x'); frame.style.removeProperty('--turn-y');
  }
  frame.addEventListener('pointerleave', clearDepth);
  reducedMotion.addEventListener('change', () => { clearDepth(); imageAnimation?.cancel(); });

  const guide = $('#walkthrough');
  let step = 0;
  const steps = [
    { title: 'Start with your panel.', description: 'Open Game Info and choose NBA, MLB, NFL or NHL. The Game and Player 1 menus contain the two original sample scenes for that sport. Choose either menu to load the matching player and image.', label: 'FOUR SPORTS. ONE PANEL.', icon: '▣' },
    { title: 'Look above the player.', description: 'The badge is already part of each original image. A player name sits above a short line of context. Choose Inspect badge to enlarge that detail without adding another overlay.', label: 'THE BADGE IS THE POINT', icon: '↗' },
    { title: 'Make the connection.', description: 'Your selected player, team and badge values stay connected to the image. Use Focus badge to look closer, or choose another player in Game Info. This is a recreation of the panel using concept art, not a live connection to the desktop app.', label: 'YOUR PLAYER. THE RIGHT SCENE.', icon: '⌖' }
  ];
  function renderStep() {
    const item = steps[step];
    $('#guide-count').textContent = `THE QUICK TOUR · 0${step + 1} / 03`;
    $('#guide-title').textContent = item.title;
    $('#guide-description').textContent = item.description;
    $('#guide-visual-label').textContent = item.label;
    $('.guide-cross').textContent = item.icon;
    $('#guide-back').hidden = step === 0;
    $('#guide-next').innerHTML = step === 2 ? 'Explore the scenes <span aria-hidden="true">↗</span>' : 'Next <span aria-hidden="true">→</span>';
  }
  $('#guide-start').addEventListener('click', () => { step = 0; renderStep(); guide.showModal(); });
  $('.dialog-close').addEventListener('click', () => guide.close());
  $('#guide-back').addEventListener('click', () => { step = Math.max(0, step - 1); renderStep(); if (step === 0) $('#guide-next').focus(); });
  $('#guide-next').addEventListener('click', () => {
    if (step === 2) { guide.close(); canvas.focus(); return; }
    step++; renderStep();
  });
  guide.addEventListener('click', event => {
    const box = guide.getBoundingClientRect();
    if (event.target === guide && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) guide.close();
  });
  render();
  const oldAnchors = { '#demo': '#experience', '#preview': '#experience', '#features': '#how-it-works', '#partners-preview': '.partner-strip' };
  if (oldAnchors[location.hash]) $(oldAnchors[location.hash])?.scrollIntoView();
})();
