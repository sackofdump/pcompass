document.getElementById('paywallModal').style.display='flex';
document.getElementById('paywallModal').style.display='none';
// re-close on load

// ── GOOGLE AUTH REDIRECT HANDLER ─────────────────────────────
// Handles the return from Google OAuth (code flow for iOS, GIS for web).
(function() {
  // Authorization code flow (iOS native via ASWebAuthenticationSession)
  var sp = new URLSearchParams(window.location.search);
  var code = sp.get('code');
  var state = sp.get('state');
  if (code && state === 'ios_native') {
    history.replaceState(null, '', window.location.pathname);
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code: code }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.idToken) {
        window.location.href = 'pcompass://auth?id_token=' + encodeURIComponent(data.idToken);
      }
    })
    .catch(function() {});
    return;
  }

  // Legacy hash-based id_token flow (fallback)
  var h = window.location.hash;
  if (!h || !h.includes('id_token')) return;
  var params = new URLSearchParams(h.substring(1));
  var idToken = params.get('id_token');
  if (!idToken || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) return;

  if (h.indexOf('state=ios_native') !== -1) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    window.location.href = 'pcompass://auth?id_token=' + encodeURIComponent(idToken);
    return;
  }

  history.replaceState(null, '', window.location.pathname + window.location.search);
  window.addEventListener('DOMContentLoaded', function() {
    if (typeof handleGoogleResponse === 'function') {
      handleGoogleResponse({ credential: idToken });
    }
  });
})();

// ── iOS APP DETECTION ─────────────────────────────────────
// Detects if running inside a native iOS WebView (PWABuilder wrapper)
// Used to hide Stripe payment links (Apple Guideline 3.1.1)
function isIOSApp() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  // WKWebView doesn't have Safari in the UA string
  const isWebView = isIOS && !(/Safari/.test(ua));
  return isIOS && (isStandalone || isWebView);
}

const _isIOSApp = isIOSApp();

// Hide Stripe purchase buttons and payment references inside iOS app (Apple Guideline 3.1.1)
if (_isIOSApp) {
  document.addEventListener('DOMContentLoaded', function() {
    // Hide upgrade modal pricing tiers and Stripe buttons entirely
    var tiers = document.querySelector('.upgrade-tiers');
    if (tiers) tiers.style.display = 'none';
    var actions = document.querySelector('.upgrade-actions');
    if (actions) {
      actions.innerHTML =
        '<div style="text-align:center;padding:12px 0;">' +
          '<p style="color:#8a9ab8;font-size:12px;margin:0;">This feature requires a Pro subscription.</p>' +
        '</div>';
    }
    // Hide all "Restore Purchases" buttons (upgrade modal + paywall modal + user menu)
    document.querySelectorAll('[onclick*="restorePurchases"]').forEach(function(btn) {
      btn.style.display = 'none';
    });
    // Hide the Pro upgrade button in header entirely
    var btnPro = document.getElementById('btnPro');
    if (btnPro) btnPro.style.display = 'none';
  });
}

let currentUser = null;

// ── AUTH GUARD ──────────────────────────────────────────
function requireAuth() {
  if (currentUser) return true;
  showAuthModalOptimized();
  return false;
}

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Restore Purchases — requires sign-in, uses authenticated email
function restorePurchases() {
  if (!currentUser || !currentUser.email) {
    showToast('Sign in first to restore your Pro purchase.');
    showAuthModalOptimized();
    return;
  }
  const email = currentUser.email;
  verifyProAccess(email).then(isPro => {
    if (isPro) {
      closePaywall();
      showToast('Pro access restored!');
    } else {
      showToast('No active Pro subscription found for ' + email + '.');
    }
  });
}

// ── PRO VERIFICATION SYSTEM ─────────────────────────────
// Pro token now lives in HttpOnly cookie — JS checks expiry flag only
function isProUser() {
  return Date.now() < parseInt(localStorage.getItem('pc_pro_expiry') || '0');
}

async function verifyProAccess(email) {
  try {
    const res = await fetch('/api/verify-pro?email=' + encodeURIComponent(email));
    const data = await res.json();
    if (data.pro) {
      localStorage.setItem('pc_pro_email', email.toLowerCase().trim());
      localStorage.setItem('pc_pro_expiry', String(Date.now() + (data.expiresIn || 14400) * 1000));
      localStorage.setItem('pc_pro_plan', data.plan || 'pro');
      updateUserUI();
      return true;
    } else {
      localStorage.removeItem('pc_pro_expiry');
      return false;
    }
  } catch(e) {
    console.warn('Pro verification failed:', e.message);
    // If server is down, honor existing valid expiry
    return isProUser();
  }
}

// Check pro status on page load
(async function checkProStatus() {
  // Legacy cleanup: remove old token-based localStorage keys
  localStorage.removeItem('pc_pro_token');
  localStorage.removeItem('pc_pro_ts');
  localStorage.removeItem('pc_auth_token');
  localStorage.removeItem('pc_auth_ts');
  localStorage.removeItem('pc_pro'); // clear insecure flag

  const email = localStorage.getItem('pc_pro_email');
  const hasUser = localStorage.getItem('pc_user');
  if (email && hasUser) {
    // Re-verify on load (refreshes cookie) — only if user is signed in
    await verifyProAccess(email);
  }
})();

// Sticky analyze button for mobile
(function initStickyAnalyze() {
  const sticky = document.createElement('button');
  sticky.className = 'btn-analyze-sticky';
  sticky.textContent = 'Analyze & Recommend';
  sticky.onclick = function() { analyzeDebounced(); };
  document.body.appendChild(sticky);

  function checkSticky() {
    if (holdings.length > 0 && window.innerWidth <= 900) {
      sticky.classList.add('visible');
    } else {
      sticky.classList.remove('visible');
    }
  }

  // Check on holdings change
  const origRender = window.renderHoldings;
  if (typeof origRender === 'function') {
    window.renderHoldings = function() {
      origRender();
      checkSticky();
    };
  }

  window.addEventListener('resize', checkSticky);
  checkSticky();
})();

// Pro status checked above in PRO VERIFICATION SYSTEM

// ── PURCHASE FLOW ────────────────────────────────────────
function goToPurchase(stripeUrl) {
  if (_isIOSApp) {
    showToast('This feature requires a Pro subscription.');
    return;
  }
  const savedEmail = localStorage.getItem('pc_pro_email') || '';
  const email = prompt('Enter your email to activate Pro after purchase:', savedEmail);
  if (!email || !email.includes('@')) {
    showToast('Please enter a valid email to continue.');
    return;
  }
  localStorage.setItem('pc_pro_email', email.toLowerCase().trim());
  localStorage.setItem('pc_checkout_pending', 'true');
  // Append email to Stripe link as prefill
  const separator = stripeUrl.includes('?') ? '&' : '?';
  window.location.href = stripeUrl + separator + 'prefilled_email=' + encodeURIComponent(email);
}


// Check if returning from Stripe checkout
(async function checkPostCheckout() {
  if (localStorage.getItem('pc_checkout_pending') === 'true') {
    localStorage.removeItem('pc_checkout_pending');
    const email = localStorage.getItem('pc_pro_email');
    if (email) {
      showToast('Verifying your purchase...');
      // Give Stripe webhook a moment to process
      await new Promise(r => setTimeout(r, 3000));
      const isPro = await verifyProAccess(email);
      if (isPro) {
        showToast('Pro activated! Enjoy unlimited access.');
      } else {
        // Webhook might be slow — retry once more
        await new Promise(r => setTimeout(r, 5000));
        const retry = await verifyProAccess(email);
        if (retry) {
          showToast('Pro activated! Enjoy unlimited access.');
        } else {
          showToast('Purchase processing — Pro will activate shortly. Use Restore Purchases if needed.');
        }
      }
    }
  }
})();

// ── GOOGLE SIGN-IN & CLOUD SYNC ─────────────────────────
const GOOGLE_CLIENT_ID = '564027426495-8p19f9da30bikcsjje4uv0up59tgf9i5.apps.googleusercontent.com';

// Initialize Google Identity Services
let _googleInitialized = false;
function initGoogleSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    setTimeout(initGoogleSignIn, 500);
    return;
  }
  if (_googleInitialized) return;
  _googleInitialized = true;
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleResponse,
    auto_select: false,
  });
}
initGoogleSignIn();

// OAuth popup for iOS WebView (intercepted by native window.open override)
function openGoogleOAuthPopup() {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(window.location.origin)}&response_type=code&scope=openid%20email%20profile`;
  window.open(url, 'google-signin', 'width=500,height=600');
}

function googleSignIn() {
  // iOS WebView: GIS doesn't work, use OAuth popup (intercepted by native app)
  if (isIOSApp()) {
    openGoogleOAuthPopup();
    return;
  }

  // Web: use Google Identity Services renderButton (no popup/redirect needed)
  if (typeof google === 'undefined' || !google.accounts) {
    loadGoogleSignInScript().then(() => googleSignIn());
    return;
  }
  if (!_googleInitialized) initGoogleSignIn();

  const container = document.getElementById('googleSignInContainer');
  const fallback = document.getElementById('googleSignInFallback');
  if (container) {
    container.innerHTML = '';
    google.accounts.id.renderButton(container, {
      type: 'standard',
      theme: 'filled_black',
      size: 'large',
      width: container.offsetWidth || 300,
      text: 'continue_with',
    });
    container.style.display = 'block';
    if (fallback) fallback.style.display = 'none';
  }
}

async function handleGoogleResponse(response) {
  if (!response.credential) return;

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();

    if (data.success && data.user) {
      currentUser = data.user;
      localStorage.setItem('pc_user', JSON.stringify(data.user));
      localStorage.setItem('pc_pro_email', data.user.email);
      updateUserUI();
      showToast('Signed in as ' + data.user.name + '!');

      // Auto-check Pro status (refreshes cookie, sets pc_pro_expiry)
      await verifyProAccess(data.user.email);

      // Auto-sync portfolios from cloud
      await syncPortfoliosFromCloud();
    } else {
      showToast('Sign in failed. Please try again.');
    }
  } catch (err) {
    console.error('Sign in error:', err);
    showToast('Sign in failed. Please try again.');
  }
}

function updateUserUI() {
  const signInBtn = document.getElementById('btnSignIn');
  const avatar = document.getElementById('userAvatar');
  const avatarImg = document.getElementById('userAvatarImg');
  const menuName = document.getElementById('userMenuName');
  const menuEmail = document.getElementById('userMenuEmail');
  const proStatus = document.getElementById('userMenuProStatus');

  if (currentUser) {
    signInBtn.style.display = 'none';
    avatar.style.display = 'flex';
    if (currentUser.picture) {
      avatarImg.src = currentUser.picture;
      avatarImg.style.display = 'block';
      avatar.querySelector('.avatar-initials')?.remove();
    } else {
      // Show initials circle for email users
      avatarImg.style.display = 'none';
      const initials = (currentUser.name || currentUser.email || '?')[0].toUpperCase();
      avatar.querySelector('.avatar-initials')?.remove();
      const initialsEl = document.createElement('div');
      initialsEl.className = 'avatar-initials';
      initialsEl.textContent = initials;
      initialsEl.style.cssText = 'width:28px;height:28px;border-radius:50%;border:2px solid var(--accent);background:var(--surface2);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-family:DM Sans,sans-serif;';
      avatar.insertBefore(initialsEl, avatar.firstChild);
    }
    avatarImg.onerror = function() { this.style.display='none'; };
    menuName.textContent = currentUser.name || currentUser.email.split('@')[0];
    menuEmail.textContent = currentUser.email;
    const headerBadge = document.getElementById('proBadgeHeader');
    if (proStatus) {
      if (isProUser()) {
        const pb = document.getElementById('btnPro');
        proStatus.innerHTML = '<span style="color:#00e5a0;">✦ Pro Member</span>';
        if (pb) pb.style.display = 'none';
        if (headerBadge) headerBadge.style.display = 'inline-block';
      } else {
        if (_isIOSApp) {
          proStatus.innerHTML = '<span style="color:var(--muted);">Free Plan</span>';
        } else {
          proStatus.innerHTML = '<span style="color:var(--muted);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;" onclick="event.stopPropagation();toggleFreePlanInfo();">Free Plan</span> · <a href="#" onclick="showPaywall(\'sync\');toggleUserMenu();return false;" style="color:#00e5a0;text-decoration:none;">Upgrade</a>' +
            '<div id="freePlanInfo" style="display:none;margin-top:8px;background:#0a0c10;border:1px solid #1e2430;border-radius:8px;padding:10px 12px;">' +
              '<div style="font-family:\'Space Mono\',monospace;font-size:9px;color:#8a9ab8;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Your free plan</div>' +
              '<div style="display:flex;flex-direction:column;gap:4px;font-family:\'Space Mono\',monospace;font-size:10px;color:#e8ecf0;">' +
                '<div><span style="color:#00e5a0;">✓</span> Portfolio analysis &amp; scoring</div>' +
                '<div><span style="color:#00e5a0;">✓</span> 5 stock picks per strategy</div>' +
                '<div><span style="color:#00e5a0;">✓</span> 4 ETF picks per strategy</div>' +
                '<div><span style="color:#00e5a0;">✓</span> 3 AI explanations per hour</div>' +
                '<div><span style="color:#00e5a0;">✓</span> 3 saved portfolios</div>' +
              '</div>' +
              '<div style="margin-top:8px;padding-top:6px;border-top:1px solid #1e2430;font-family:\'Space Mono\',monospace;font-size:9px;color:#8a9ab8;">Upgrade to unlock unlimited AI, expanded picks, PDF export, cloud sync &amp; more</div>' +
            '</div>';
        }
        if (headerBadge) headerBadge.style.display = 'none';
      }
    }
  } else {
    signInBtn.style.display = 'flex';
    avatar.style.display = 'none';
  }
}

function toggleFreePlanInfo() {
  const el = document.getElementById('freePlanInfo');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// Close menu when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('#userAvatar')) {
    const menu = document.getElementById('userMenu');
    if (menu) menu.style.display = 'none';
  }
});

function signOut() {
  currentUser = null;
  localStorage.removeItem('pc_user');
  localStorage.removeItem('pc_pro_expiry');
  localStorage.removeItem('pc_pro_email');
  localStorage.removeItem('pc_pro_plan');
  // Clear HttpOnly cookies server-side
  fetch('/api/signout', { method: 'POST' }).catch(() => {});
  updateUserUI();
  showToast('Signed out.');
}

async function deleteAccount() {
  var email = (currentUser && currentUser.email) || '';
  if (!email) { showToast('Not signed in.'); return; }
  if (!confirm('Delete your account?\n\nThis will permanently delete your profile, all cloud portfolios, and any Pro license. This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Type OK in the next prompt to confirm.')) return;
  var typed = prompt('Type DELETE to permanently delete your account:');
  if (typed !== 'DELETE') { showToast('Account deletion cancelled.'); return; }
  try {
    var headers = getAuthHeaders();
    headers['Content-Type'] = 'application/json';
    var res = await fetch('/api/delete-account', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ email: email }),
    });
    var data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to delete account.'); return; }
    currentUser = null;
    localStorage.clear();
    updateUserUI();
    showToast('Account deleted.');
    setTimeout(function() { location.reload(); }, 1500);
  } catch(e) {
    showToast('Error deleting account. Please try again.');
  }
}

// ── CLOUD PORTFOLIO SYNC ────────────────────────────────
// Auth/Pro tokens now travel via HttpOnly cookies — no JS headers needed
function getAuthHeaders() {
  return {};
}

async function savePortfolioToCloud(name, holdingsData) {
  if (!currentUser || !isProUser()) return null;
  try {
    const res = await fetch('/api/portfolios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: currentUser.id,
        name: name,
        holdings: holdingsData,
      }),
    });
    const data = await res.json();
    if (data.portfolio) {
      showToast('☁️ Saved to cloud!');
      return data.portfolio;
    }
  } catch (err) {
    console.warn('Cloud save failed:', err);
  }
  return null;
}

async function syncPortfoliosFromCloud() {
  if (!currentUser) {
    showToast('Sign in to sync portfolios.');
    return;
  }
  if (!isProUser()) {
    showPaywall('sync');
    return;
  }
  try {
    const res = await fetch('/api/portfolios?userId=' + currentUser.id, {
      credentials: 'include',
    });
    const data = await res.json();
    if (data.portfolios && data.portfolios.length > 0) {
      // Merge cloud portfolios into local storage
      const localPortfolios = JSON.parse(localStorage.getItem('pc_portfolios') || '[]');
      let added = 0;
      data.portfolios.forEach(cp => {
        const exists = localPortfolios.find(lp => lp.name === cp.name);
        if (!exists) {
          localPortfolios.push({
            name: cp.name,
            holdings: typeof cp.holdings === 'string' ? JSON.parse(cp.holdings) : cp.holdings,
            cloudId: cp.id,
          });
          added++;
        } else if (!exists.cloudId) {
          exists.cloudId = cp.id;
        }
      });
      localStorage.setItem('pc_portfolios', JSON.stringify(localPortfolios));
      renderPortfolioSlots();
      showToast('☁️ Synced ' + data.portfolios.length + ' portfolio(s) from cloud' + (added > 0 ? ' (+' + added + ' new)' : ''));
    } else {
      showToast('No cloud portfolios found. Save one to sync!');
    }
  } catch (err) {
    console.warn('Cloud sync failed:', err);
    showToast('Sync failed. Check your connection.');
  }
}

// Hook into the existing savePortfolio function to also save to cloud
const origSavePortfolio = window.savePortfolio;
window.savePortfolio = async function() {
  // Call original save (to localStorage) — it's async now
  if (typeof origSavePortfolio === 'function') await origSavePortfolio();

  // Also save to cloud if signed in
  if (currentUser && holdings.length > 0) {
    const name = document.querySelector('#saveModal input')?.value ||
                 localStorage.getItem('pc_last_saved_name') ||
                 'My Portfolio';
    savePortfolioToCloud(name, holdings);
  }
};

// Restore user session on page load
(function restoreUserSession() {
  const saved = localStorage.getItem('pc_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      updateUserUI();
    } catch(e) {
      localStorage.removeItem('pc_user');
    }
  }
})();

// ── APPLE SIGN-IN ────────────────────────────────────────
const APPLE_CLIENT_ID = 'com.pcompass.signin';

function loadAppleSignInScript() {
  if (window._appleScriptLoaded) return Promise.resolve();
  if (window._appleScriptLoading) return window._appleScriptLoading;
  window._appleScriptLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    script.async = true;
    script.onload = () => { window._appleScriptLoaded = true; resolve(); };
    script.onerror = () => { window._appleScriptLoading = null; reject(new Error('Failed to load Apple Sign-In')); };
    document.head.appendChild(script);
  });
  return window._appleScriptLoading;
}

async function appleSignIn() {
  try {
    await loadAppleSignInScript();
    AppleID.auth.init({
      clientId: APPLE_CLIENT_ID,
      scope: 'name email',
      redirectURI: window.location.origin,
      usePopup: true,
    });
    const response = await AppleID.auth.signIn();
    const body = { id_token: response.authorization.id_token };
    // User info (name) is only sent on first sign-in
    if (response.user) body.user = response.user;
    const res = await fetch('/api/auth-apple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success && data.user) {
      currentUser = data.user;
      localStorage.setItem('pc_user', JSON.stringify(data.user));
      localStorage.setItem('pc_pro_email', data.user.email);
      updateUserUI();
      showToast('Signed in as ' + data.user.name + '!');
      await verifyProAccess(data.user.email);
      await syncPortfoliosFromCloud();
    } else {
      showToast('Sign in failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    if (err.error === 'popup_closed_by_user') return;
    console.error('Apple Sign-In error:', err);
    showToast('Apple Sign-In failed. Please try again.');
  }
}

// ── PATCH 1: MARKET DATA localStorage CACHE ──────────────────
async function fetchMarketDataCached(tickersToFetch) {
  const CACHE_KEY = 'pc_market_' + tickersToFetch.slice().sort().join(',');
  const CACHE_TTL = 60 * 60 * 1000; // 1 hour
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { data, ts } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL) {
        console.log('[market-data] serving from localStorage cache');
        return data;
      }
    }
  } catch(e) { /* ignore stale/corrupt cache */ }
  try {
    const res = await fetch('/api/market-data?tickers=' + tickersToFetch.join(','));
    const raw = await res.json();
    const marketData = {};
    for (const [ticker, val] of Object.entries(raw)) {
      if (!val) { marketData[ticker] = null; continue; }
      marketData[ticker] = {
        price:       Number(val.price) || 0,
        changePct:   val.changePct != null ? Number(val.changePct) : (val.change != null ? Number(val.change) : 0),
        momentum:    val.momentum != null ? val.momentum : 50 + Math.min(15, Math.max(-15, Number(val.changePct || val.change || 0) * 5)),
        marketState: val.marketState || 'REGULAR',
        name:        val.name || ticker,
      };
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data: marketData, ts: Date.now() }));
    } catch(e) { /* localStorage quota exceeded — skip cache write */ }
    return Object.keys(marketData).length > 0 ? marketData : null;
  } catch(e) {
    console.warn('[market-data] fetch failed:', e.message);
    return null;
  }
}

// ── PATCH 2: ANALYZE DEBOUNCE ─────────────────────────────────
let analyzeDebounceTimer = null;
function analyzeDebounced() {
  clearTimeout(analyzeDebounceTimer);
  analyzeDebounceTimer = setTimeout(() => analyze(), 300);
}

// ── PATCH 4: LAZY GOOGLE SIGN-IN ─────────────────────────────
function loadGoogleSignInScript() {
  if (window._googleScriptLoaded) return Promise.resolve();
  if (window._googleScriptLoading) return window._googleScriptLoading;
  window._googleScriptLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window._googleScriptLoaded = true;
      if (typeof initGoogleSignIn === 'function') initGoogleSignIn();
      resolve();
    };
    script.onerror = () => {
      window._googleScriptLoading = null;
      reject(new Error('Failed to load Google Sign-In'));
    };
    document.head.appendChild(script);
  });
  return window._googleScriptLoading;
}
function showAuthModalOptimized() {
  document.getElementById('authModal').style.display = 'flex';
  // Reset: show fallback button, hide GIS container until rendered
  const fallback = document.getElementById('googleSignInFallback');
  const container = document.getElementById('googleSignInContainer');
  if (fallback) fallback.style.display = 'flex';
  if (container) container.style.display = 'none';
  // Load GIS SDK and render Google button
  loadGoogleSignInScript().then(() => googleSignIn()).catch(() => {});
}

// ── PATCH 5: callClaudeAPI is defined at the top of the main script block ────

// ── PATCH 6: CLEAR MARKET CACHE (called before manual refresh) ─
function clearMarketCache() {
  const keysToDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('pc_market_')) keysToDelete.push(key);
  }
  keysToDelete.forEach(k => localStorage.removeItem(k));
  console.log('[market-data] localStorage cache cleared');
}

// ── PATCH 7: INTERACTIVE PAYWALL TIER SELECTION ───────────────
let selectedPaywallTier = 'monthly';

// Pricing & Stripe URLs injected dynamically on web only (not iOS — Apple Guideline 3.1.1)
const paywallTiers = {};

function selectPaywallTier(tier) {
  selectedPaywallTier = tier;
  const ids = ['tier-monthly', 'tier-annual', 'tier-lifetime'];
  const keys = ['monthly', 'annual', 'lifetime'];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.borderColor = keys[i] === tier ? '#00e5a0' : '#1e2430';
  });
  const btn = document.getElementById('paywallConfirmBtn');
  const t = paywallTiers[tier];
  if (btn && t) {
    btn.textContent = t.label;
    btn.onclick = function() { goToPurchase(t.url); };
  }
}

// ── PATCH 8: OFFLINE PORTFOLIO VIEWING ────────────────────────────
(function initOfflineSupport() {
  var offlineBanner = null;
  var disabledEls = [];
  var analysisObserver = null;
  var CACHE_KEY = 'pc_cached_analysis';
  var CACHE_TS_KEY = 'pc_cached_analysis_ts';

  function showOfflineBanner() {
    if (offlineBanner) return;
    offlineBanner = document.createElement('div');
    offlineBanner.id = 'offlineBanner';
    offlineBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b8860b;color:#fff;text-align:center;padding:6px 12px;font-family:"Space Mono",monospace;font-size:11px;letter-spacing:0.5px;';
    offlineBanner.textContent = "You\u2019re offline \u2014 viewing saved data";
    document.body.appendChild(offlineBanner);
    // Push body content down
    document.body.style.marginTop = (offlineBanner.offsetHeight || 28) + 'px';
  }

  function hideOfflineBanner() {
    if (!offlineBanner) return;
    offlineBanner.remove();
    offlineBanner = null;
    document.body.style.marginTop = '';
  }

  function disableControls() {
    var selectors = ['#analyzeBtn', '.btn-analyze-sticky', '#refreshMarketBtn'];
    disabledEls = [];
    selectors.forEach(function(sel) {
      var el = document.querySelector(sel);
      if (el) {
        el.dataset.pcWasDisabled = el.disabled ? 'true' : 'false';
        el.disabled = true;
        el.style.opacity = '0.4';
        el.style.pointerEvents = 'none';
        disabledEls.push(el);
      }
    });
  }

  function enableControls() {
    disabledEls.forEach(function(el) {
      if (el.dataset.pcWasDisabled !== 'true') {
        el.disabled = false;
      }
      el.style.opacity = '';
      el.style.pointerEvents = '';
      delete el.dataset.pcWasDisabled;
    });
    disabledEls = [];
  }

  // Cache analysis HTML when it changes
  function startObserving() {
    var panel = document.getElementById('resultsPanel');
    if (!panel || analysisObserver) return;
    analysisObserver = new MutationObserver(function() {
      var html = panel.innerHTML.trim();
      if (html && html.length > 100) {
        try {
          localStorage.setItem(CACHE_KEY, html);
          localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
        } catch(e) { /* quota exceeded */ }
      }
    });
    analysisObserver.observe(panel, { childList: true, subtree: true, characterData: true });
  }

  function restoreCachedAnalysis() {
    var panel = document.getElementById('resultsPanel');
    if (!panel) return;
    // Only restore if panel is currently empty
    if (panel.innerHTML.trim().length > 100) return;
    var cached = localStorage.getItem(CACHE_KEY);
    var ts = parseInt(localStorage.getItem(CACHE_TS_KEY) || '0');
    if (!cached) return;
    var age = Date.now() - ts;
    var ageText = age < 60000 ? 'just now' :
                  age < 3600000 ? Math.round(age / 60000) + 'm ago' :
                  age < 86400000 ? Math.round(age / 3600000) + 'h ago' :
                  Math.round(age / 86400000) + 'd ago';
    var badge = '<div style="background:#b8860b;color:#fff;padding:6px 12px;border-radius:8px;margin-bottom:12px;font-family:\'Space Mono\',monospace;font-size:10px;text-align:center;letter-spacing:0.5px;">Cached analysis from ' + ageText + '</div>';
    panel.innerHTML = badge + cached;
  }

  function goOffline() {
    showOfflineBanner();
    disableControls();
    restoreCachedAnalysis();
  }

  function goOnline() {
    hideOfflineBanner();
    enableControls();
  }

  window.addEventListener('offline', goOffline);
  window.addEventListener('online', goOnline);

  // Start observing once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      startObserving();
      if (!navigator.onLine) goOffline();
    });
  } else {
    startObserving();
    if (!navigator.onLine) goOffline();
  }
})();

// ── DYNAMIC PRICING INJECTION (web only) ─────────────────────────
// Stripe URLs and dollar amounts are NOT in the HTML source.
// They are injected here at runtime, only on non-iOS platforms,
// so Apple's review does not flag external payment references.
if (!_isIOSApp) {
  document.addEventListener('DOMContentLoaded', function() {
    var S = {
      monthly:  { url: 'https://buy.stripe.com/28E8wPb66b4Y4aj0M96AM03', price: '$1.99', period: '/mo', label: 'Get Pro \u2014 $1.99/mo' },
      annual:   { url: 'https://buy.stripe.com/28EdR94HIc926ir66t6AM05', price: '$14.99', period: '/yr', label: 'Annual \u2014 $14.99/yr (save 37%)' },
      lifetime: { url: 'https://buy.stripe.com/14AeVddeedd64aj3Yl6AM04', price: '$19.99', period: '', label: 'Lifetime \u2014 $19.99' },
    };

    // Populate paywallTiers for selectPaywallTier()
    paywallTiers.monthly  = { url: S.monthly.url,  label: S.monthly.label };
    paywallTiers.annual   = { url: S.annual.url,   label: 'Get Annual \u2014 $14.99/yr' };
    paywallTiers.lifetime = { url: S.lifetime.url,  label: 'Get Lifetime \u2014 $19.99' };

    // Upgrade modal — tier prices
    var upPrices = document.querySelectorAll('.upgrade-tier-price');
    if (upPrices[0]) upPrices[0].textContent = '$0';
    if (upPrices[1]) upPrices[1].innerHTML = S.monthly.price + '<span>' + S.monthly.period + '</span>';
    if (upPrices[2]) upPrices[2].innerHTML = S.annual.price + '<span>' + S.annual.period + '</span>';
    if (upPrices[3]) upPrices[3].innerHTML = S.lifetime.price + '<span> one-time</span>';

    // Upgrade modal — action buttons
    var upBtns = document.querySelectorAll('.upgrade-actions button');
    if (upBtns[0]) { upBtns[0].textContent = S.monthly.label; upBtns[0].onclick = function() { goToPurchase(S.monthly.url); }; }
    if (upBtns[1]) { upBtns[1].textContent = S.annual.label; upBtns[1].onclick = function() { goToPurchase(S.annual.url); }; }
    if (upBtns[2]) { upBtns[2].textContent = S.lifetime.label; upBtns[2].onclick = function() { goToPurchase(S.lifetime.url); }; }

    // Paywall modal — tier prices
    var pwPrices = document.querySelectorAll('.pw-tier-price');
    if (pwPrices[0]) pwPrices[0].innerHTML = S.monthly.price + '<span style="font-size:11px;color:#8a9ab8;">' + S.monthly.period + '</span>';
    if (pwPrices[1]) pwPrices[1].innerHTML = S.annual.price + '<span style="font-size:11px;color:#8a9ab8;">' + S.annual.period + '</span>';
    if (pwPrices[2]) pwPrices[2].textContent = S.lifetime.price;

    // Sign-in teaser
    var teaser = document.getElementById('signInProTeaser');
    if (teaser) teaser.textContent = 'Free to join \u00b7 Pro from $1.99/mo';

    // Paywall modal — confirm button
    var confirmBtn = document.getElementById('paywallConfirmBtn');
    if (confirmBtn) {
      confirmBtn.textContent = S.monthly.label;
      confirmBtn.onclick = function() { goToPurchase(S.monthly.url); };
    }
  });
}
