/* =============================================
   STATIONWAVE — config.js

   ⚙️  ONE FILE TO CHANGE WHEN YOU DEPLOY.

   After you deploy the backend to Railway:
   1. Copy your Railway URL  (e.g. https://stationwave-production.up.railway.app)
   2. Paste it as BACKEND_URL below
   3. Re-deploy the frontend to Vercel
   ============================================= */

const CONFIG = (() => {
  /* ── Detect environment ── */
  const isLocalhost =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';

  /* ── URLs ── */
  const LOCAL_BACKEND   = 'http://localhost:3001';

  /*
   * 🚀 PRODUCTION — paste your Railway URL here:
   *    e.g. 'https://stationwave-production.up.railway.app'
   */
  const PROD_BACKEND    = 'https://stationwave-production.up.railway.app';

  const BACKEND_URL = isLocalhost ? LOCAL_BACKEND : PROD_BACKEND;

  /* PeerJS connects to the same host as the backend */
  const peerUrl  = new URL(BACKEND_URL);
  const PEER_CONFIG = {
    host:   peerUrl.hostname,
    port:   peerUrl.port ? Number(peerUrl.port) : (peerUrl.protocol === 'https:' ? 443 : 80),
    path:   '/peerjs',
    secure: peerUrl.protocol === 'https:',
  };

  return {
    BACKEND_URL,
    PEER_CONFIG,
    IS_LOCAL: isLocalhost,
  };
})();

/* Make available globally */
window.SW_CONFIG = CONFIG;

console.log(`[STATIONWAVE] Backend: ${CONFIG.BACKEND_URL} (${CONFIG.IS_LOCAL ? 'local' : 'production'})`);
