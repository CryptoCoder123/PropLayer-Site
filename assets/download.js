/* Public download page. Reads the latest GitHub release (contract C8).

   No account is needed and none is asked for: access is enforced by the app, not by hiding
   the installer. The release body comes from a repository we control but is still treated as
   untrusted text — it is rendered through DOM APIs, never innerHTML.
*/
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const config = window.PROPLAYER_CONFIG ?? {};
  const PLACEHOLDER = '__SET_ME__';

  const repo = (typeof config.releasesRepo === 'string' && config.releasesRepo !== PLACEHOLDER)
    ? config.releasesRepo.replace(/^\/+|\/+$/g, '')
    : 'CryptoCoder123/PropLayer-Releases';

  const RELEASES_PAGE = `https://github.com/${repo}/releases/latest`;
  const INSTALLER = /^PropLayer-Setup-(\d+\.\d+\.\d+)\.exe$/;
  const FFMPEG_SOURCE = /^PropLayer-ffmpeg-source-.*\.zip$/;
  const CHECKSUMS = 'SHA256SUMS.txt';
  const REQUEST_TIMEOUT_MS = 12_000;

  // The no-JavaScript fallback link is static in the HTML; keep it honest if the repo
  // name in config.js ever differs from the default.
  const noscriptLink = $('noscript-link');
  if (noscriptLink) noscriptLink.href = RELEASES_PAGE;

  function showFallback(detail) {
    const card = $('release-card');
    card.removeAttribute('aria-busy');
    $('release-title').textContent = 'Download from the releases page';
    $('release-facts').hidden = true;
    $('release-download').hidden = true;
    $('release-hash').hidden = true;
    $('release-extra').hidden = true;
    $('release-fallback-detail').textContent = detail;
    $('release-fallback-link').href = RELEASES_PAGE;
    $('release-fallback').hidden = false;
  }

  const megabytes = bytes =>
    Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : null;

  const longDate = value => {
    const ms = Date.parse(value ?? '');
    return Number.isFinite(ms)
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(ms))
      : null;
  };

  /**
   * A deliberately small Markdown subset — headings, list items, bold/italic/code spans and
   * links — built with DOM nodes. Anything it does not recognise stays literal text, which is
   * the safe failure mode for a notice we must display accurately.
   */
  function renderNotice(markdown, target) {
    target.textContent = '';
    const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
    let list = null;
    let paragraph = null;

    const endParagraph = () => { paragraph = null; };
    const endList = () => { list = null; };

    for (const raw of lines) {
      const line = raw.trimEnd();

      if (!line.trim()) { endParagraph(); endList(); continue; }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        endParagraph(); endList();
        // Headings inside the notice sit below the card's own h2.
        const level = Math.min(3 + heading[1].length - 1, 6);
        const node = document.createElement(`h${level}`);
        appendInline(heading[2], node);
        target.appendChild(node);
        continue;
      }

      const item = line.match(/^\s*[-*+]\s+(.*)$/);
      if (item) {
        endParagraph();
        if (!list) { list = document.createElement('ul'); target.appendChild(list); }
        const li = document.createElement('li');
        appendInline(item[1], li);
        list.appendChild(li);
        continue;
      }

      endList();
      if (!paragraph) { paragraph = document.createElement('p'); target.appendChild(paragraph); }
      else paragraph.appendChild(document.createTextNode(' '));
      appendInline(line, paragraph);
    }

    if (!target.childNodes.length) target.textContent = String(markdown ?? '');
  }

  /** Inline spans: `code`, **bold**, *italic*, [text](https://url) and bare https URLs. */
  function appendInline(text, parent) {
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>)]+)/g;
    let index = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > index) parent.appendChild(document.createTextNode(text.slice(index, match.index)));

      const [, code, bold, italic, linkText, linkHref, bareUrl] = match;
      if (code !== undefined) {
        const node = document.createElement('code');
        node.textContent = code;
        parent.appendChild(node);
      } else if (bold !== undefined) {
        const node = document.createElement('strong');
        node.textContent = bold;
        parent.appendChild(node);
      } else if (italic !== undefined) {
        const node = document.createElement('em');
        node.textContent = italic;
        parent.appendChild(node);
      } else {
        const href = linkHref ?? bareUrl;
        // Only http(s) is ever turned into a link, so a javascript: URL in the notice stays text.
        const node = document.createElement('a');
        node.href = href;
        node.textContent = linkText ?? href;
        node.rel = 'noopener noreferrer';
        parent.appendChild(node);
      }
      index = pattern.lastIndex;
    }

    if (index < text.length) parent.appendChild(document.createTextNode(text.slice(index)));
  }

  function render(release) {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const installer = assets.find(asset => INSTALLER.test(String(asset?.name ?? '')));

    if (!installer?.browser_download_url) {
      showFallback('This release does not include a Windows installer yet. Every build is listed on the releases page.');
      return;
    }

    const version = INSTALLER.exec(installer.name)[1];
    const card = $('release-card');
    card.removeAttribute('aria-busy');
    $('release-fallback').hidden = true;

    $('release-title').textContent = `Prop Layer ${version} for Windows`;
    $('release-version').textContent = version;

    const published = longDate(release.published_at ?? release.created_at);
    $('release-published').textContent = published ?? 'Recently';
    const size = megabytes(Number(installer.size));
    $('release-size').textContent = size ?? 'See the releases page';
    $('release-facts').hidden = false;

    const download = $('release-download');
    download.href = installer.browser_download_url;
    download.setAttribute('download', '');
    download.hidden = false;

    // GitHub reports an asset digest as "sha256:<hex>"; older releases have none, in which
    // case the SHA256SUMS.txt asset is the way to verify.
    const digest = String(installer.digest ?? '');
    const sha256 = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null;
    if (sha256) {
      $('release-hash-value').textContent = sha256;
      $('release-hash').hidden = false;
    }

    const ffmpeg = assets.find(asset => FFMPEG_SOURCE.test(String(asset?.name ?? '')));
    const checksums = assets.find(asset => String(asset?.name ?? '') === CHECKSUMS);
    const ffmpegLink = $('release-ffmpeg');
    const checksumsLink = $('release-checksums');

    if (ffmpeg?.browser_download_url) {
      ffmpegLink.href = ffmpeg.browser_download_url;
      ffmpegLink.hidden = false;
    }
    if (checksums?.browser_download_url) {
      checksumsLink.href = checksums.browser_download_url;
      checksumsLink.hidden = false;
    }
    $('release-extra').hidden = ffmpegLink.hidden && checksumsLink.hidden;

    const body = String(release.body ?? '').trim();
    if (body) {
      renderNotice(body, $('release-notes'));
      $('release-notes-card').hidden = false;
    }
  }

  async function load() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal
      });

      if (response.status === 403 || response.status === 429) {
        showFallback('GitHub is rate-limiting this browser right now. The releases page has every build.');
        return;
      }
      if (response.status === 404) {
        showFallback('No public release has been published yet. Check the releases page for the latest build.');
        return;
      }
      if (!response.ok) {
        showFallback("We couldn't read the release list just now. The releases page has every build.");
        return;
      }
      render(await response.json());
    } catch {
      showFallback("We couldn't reach GitHub just now. The releases page has every build.");
    } finally {
      clearTimeout(timer);
    }
  }

  void load();

  // Exposed for the browser suite only.
  window.__PROPLAYER_DOWNLOAD__ = { renderNotice, RELEASES_PAGE };
})();
