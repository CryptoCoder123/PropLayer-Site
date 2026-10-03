// GA4 bootstrap as a file, so account.html and download.html need no inline script and can
// keep a strict Content-Security-Policy. Same measurement id as the inline bootstrap on the
// other pages. No personal data is ever sent: see the event calls in account.js.
(() => {
  const MEASUREMENT_ID = 'G-Y0S7K0W3W5';

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
  document.head.appendChild(tag);
})();
