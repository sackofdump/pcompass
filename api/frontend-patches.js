// ═══════════════════════════════════════════════════════════════
// PORTFOLIO COMPASS — FRONTEND OPTIMIZATION PATCHES
// Drop these script blocks into index.html as described below
// ═══════════════════════════════════════════════════════════════

// ── PATCH 1: MARKET DATA localStorage CACHE ──────────────────
// Replace the fetchMarketData() call inside analyze() with this version.
// Saves API calls when user clicks Analyze multiple times or refreshes.
// Cache key includes the tickers so different portfolios get different caches.

async function fetchMarketDataCached(tickersToFetch) {
  const CACHE_KEY = 'pc_market_' + tickersToFetch.slice().sort().join(',');
  const CACHE_TTL = 60 * 60 * 1000; // 1 hour

  // Check localStorage cache first
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { data, ts } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL) {
        console.log('[market-data] serving from localStorage cache');
        return data;
      }
    }
  } catch(e) { /* ignore parse errors */ }

  // Fetch fresh
  try {
    const res = await fetch('/api/market-data?tickers=' + tickersToFetch.join(','));
    const raw = await res.json();
    const marketData = {};

    for (const [ticker, val] of Object.entries(raw)) {
      if (!val) { marketData[ticker] = null; continue; }
      marketData[ticker] = {
        price:       Number(val.price) || 0,
        changePct:   val.changePct != null ? Number(val.changePct) : Number(val.change || 0),
        momentum:    val.momentum != null ? val.momentum : 50 + Math.min(15, Math.max(-15, Number(val.changePct || val.change || 0) * 5)),
        marketState: val.marketState || 'REGULAR',
        name:        val.name || ticker,
      };
    }

    // Save to localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data: marketData, ts: Date.now() }));
    } catch(e) { /* quota exceeded — skip cache */ }

    return Object.keys(marketData).length > 0 ? marketData : null;
  } catch(e) {
    console.warn('[market-data] fetch failed:', e.message);
    return null;
  }
}

// ── PATCH 2: ANALYZE DEBOUNCE ─────────────────────────────────
// Prevents double-firing if user clicks Analyze rapidly.
// Wrap the existing analyze() call with this debounce.

let analyzeDebounceTimer = null;

function analyzeDebounced() {
  clearTimeout(analyzeDebounceTimer);
  analyzeDebounceTimer = setTimeout(() => {
    analyze();
  }, 300);
}
// Then in your HTML, change: onclick="analyze()"
// To: onclick="analyzeDebounced()"
// Same for the sticky mobile button.

// ── PATCH 3: WHAT-IF DEBOUNCE ─────────────────────────────────
// Replace the existing what-if input listeners with these debounced versions.
// Prevents runWhatIf() from firing on every single keypress.

(function initWhatIfDebounced() {
  let whatifTimer = null;
  function debouncedWhatIf() {
    clearTimeout(whatifTimer);
    whatifTimer = setTimeout(runWhatIf, 300);
  }
  // Wait for DOM
  document.addEventListener('DOMContentLoaded', function() {
    const wt = document.getElementById('whatifTicker');
    const wp = document.getElementById('whatifPct');
    if (wt) { wt.removeEventListener('input', runWhatIf); wt.addEventListener('input', debouncedWhatIf); }
    if (wp) { wp.removeEventListener('input', runWhatIf); wp.addEventListener('input', debouncedWhatIf); }
  });
})();

// ── PATCH 4: LAZY GOOGLE SIGN-IN SCRIPT ──────────────────────
// Remove the <script src="https://accounts.google.com/gsi/client"> tag from <head>
// and use this instead — loads Google only when auth modal opens.

function loadGoogleSignInScript() {
  if (window._googleScriptLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window._googleScriptLoaded = true;
      initGoogleSignIn(); // your existing function
      resolve();
    };
    document.head.appendChild(script);
  });
}

// Replace your existing showAuthModal() with this version:
function showAuthModalOptimized() {
  authMode = 'login';
  const modal = document.getElementById('authModal');
  modal.style.display = 'flex';
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authPasswordConfirm').value = '';
  document.getElementById('authPasswordConfirm').style.display = 'none';
  document.getElementById('authError').style.display = 'none';
  document.getElementById('authSubmitBtn').textContent = 'Sign In';
  document.getElementById('authToggleText').textContent = "Don't have an account? ";
  document.getElementById('authToggleLink').textContent = 'Sign Up';

  // Load Google script lazily — only when auth modal is opened
  loadGoogleSignInScript();
}

// ── PATCH 5: SEND PRO HEADERS TO API ─────────────────────────
// claude.js now verifies pro server-side. Update your fetch calls to send
// the email and timestamp alongside the token.
// Replace existing fetchClaude calls with this helper:

async function callClaudeAPI(body) {
  const proToken = localStorage.getItem('pc_pro_token') || '';
  const proEmail = localStorage.getItem('pc_pro_email') || '';
  const proTs    = localStorage.getItem('pc_pro_ts')    || '';

  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pro-Token':  proToken,
      'X-Pro-Email':  proEmail,
      'X-Pro-Ts':     proTs,
    },
    body: JSON.stringify(body),
  });
  return res;
}

// ── PATCH 6: CLEAR STALE MARKET CACHE ON MANUAL REFRESH ──────
// Call this in refreshMarketData() before calling analyze()

function clearMarketCache() {
  const keysToDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('pc_market_')) keysToDelete.push(key);
  }
  keysToDelete.forEach(k => localStorage.removeItem(k));
  console.log('[market-data] cache cleared');
}
