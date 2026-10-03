// Public configuration (contract PL-ACCOUNT-1, C2). Safe to publish. Never put secrets here.
window.PROPLAYER_CONFIG = Object.freeze({
  supabaseUrl: 'https://dpyyonnbumffyuhvaxxy.supabase.co',               // https://<project-ref>.supabase.co
  supabasePublishableKey: 'sb_publishable_PmdOpyEatPbq17vvScLreA_QtLmvRZx',    // sb_publishable_… (or legacy anon key)
  siteUrl: 'https://prop-layer.com',
  releasesRepo: 'CryptoCoder123/PropLayer-Releases',
  planName: 'Prop Layer Monthly',
  priceDisplay: '__SET_ME__'               // e.g. "$14.99 / month" — must match the Stripe price
});
