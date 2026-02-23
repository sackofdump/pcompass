// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Restore Purchases — prompts for email and verifies server-side
function restorePurchases() {
  const savedEmail = localStorage.getItem('pc_pro_email');
  const email = prompt('Enter the email you used to purchase Pro:', savedEmail || '');
  if (!email || !email.includes('@')) {
    showToast('Please enter a valid email.');
    return;
  }
  verifyProAccess(email).then(isPro => {
    if (isPro) {
      closePaywall();
      showToast('Pro access restored!');
    } else {
      showToast('No active Pro subscription found for that email.');
    }
  });
}

// ── PRO VERIFICATION SYSTEM ─────────────────────────────
// Server-signed tokens prevent localStorage tampering
function isProUser() {
  const token = localStorage.getItem('pc_pro_token');
  const timestamp = parseInt(localStorage.getItem('pc_pro_ts') || '0');
  const email = localStorage.getItem('pc_pro_email');
  if (!token || !email || !timestamp) return false;
  // Token expires after 24 hours — forces re-verification
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > 86400) return false;
  return true;
}

async function verifyProAccess(email) {
  try {
    const res = await fetch('/api/verify-pro?email=' + encodeURIComponent(email));
    const data = await res.json();
    if (data.pro && data.token) {
      localStorage.setItem('pc_pro_email', email.toLowerCase().trim());
      localStorage.setItem('pc_pro_token', data.token);
      localStorage.setItem('pc_pro_ts', String(data.timestamp));
      localStorage.setItem('pc_pro_plan', data.plan || 'pro');
      localStorage.removeItem('pc_ai_uses');
      localStorage.removeItem('pc_shot_uses');
      return true;
    } else {
      localStorage.removeItem('pc_pro_token');
      localStorage.removeItem('pc_pro_ts');
      return false;
    }
  } catch(e) {
    console.warn('Pro verification failed:', e.message);
    // If server is down, honor existing valid token
    return isProUser();
  }
}

// Check pro status on page load
(async function checkProStatus() {
  // Legacy support: if old pc_pro flag exists, prompt for email migration
  if (isProUser() && !localStorage.getItem('pc_pro_token')) {
    localStorage.removeItem('pc_pro'); // clear insecure flag
  }

  const email = localStorage.getItem('pc_pro_email');
  if (email) {
    // Re-verify on load (refreshes token)
    await verifyProAccess(email);
  }

  // Clear usage limits for pro users
  if (isProUser()) {
    localStorage.removeItem('pc_ai_uses');
    localStorage.removeItem('pc_shot_uses');
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
let currentUser = null;
const GOOGLE_CLIENT_ID = '564027426495-8p19f9da30bikcsjje4uv0up59tgf9i5.apps.googleusercontent.com';

// Initialize Google Sign-In on page load
function initGoogleSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    setTimeout(initGoogleSignIn, 500);
    return;
  }
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleResponse,
    auto_select: false,
  });
}
initGoogleSignIn();

function googleSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    showToast('Google Sign-In loading... try again in a moment.');
    return;
  }
  // Render a hidden div and trigger sign-in via prompt
  google.accounts.id.prompt((notification) => {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      // One Tap not available, fall back to popup
      const popup = window.open(
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(window.location.origin)}&response_type=token%20id_token&scope=email%20profile&nonce=${Math.random().toString(36).slice(2)}`,
        'google-signin',
        'width=500,height=600,left=200,top=100'
      );
      // Listen for redirect back
      const checkPopup = setInterval(() => {
        try {
          if (popup.closed) { clearInterval(checkPopup); return; }
          if (popup.location.origin === window.location.origin) {
            const hash = popup.location.hash.substring(1);
            const params = new URLSearchParams(hash);
            const idToken = params.get('id_token');
            popup.close();
            clearInterval(checkPopup);
            if (idToken) {
              handleGoogleResponse({ credential: idToken });
            }
          }
        } catch(e) { /* cross-origin, keep waiting */ }
      }, 500);
    }
  });
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
    avatar.style.display = 'block';
    if (currentUser.picture) {
      avatarImg.src = currentUser.picture;
      avatarImg.style.display = 'block';
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
    if (proStatus) {
      if (isProUser()) {
        proStatus.innerHTML = '<span style="color:#00e5a0;">✦ Pro Member</span>';
        const pb = document.getElementById('btnPro');
        if (pb) pb.style.display = 'none';
      } else {
        proStatus.innerHTML = '<span style="color:var(--muted);">Free Plan</span> · <a href="#" onclick="showPaywall(\'sync\');toggleUserMenu();return false;" style="color:#00e5a0;text-decoration:none;">Upgrade</a>';
      }
    }
  } else {
    signInBtn.style.display = 'flex';
    avatar.style.display = 'none';
  }
}

// ── AUTH MODAL ──────────────────────────────────────────
let authMode = 'login'; // 'login' or 'signup'

function showAuthModal() {
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
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('authPasswordConfirm').style.display = authMode === 'signup' ? 'block' : 'none';
  document.getElementById('authSubmitBtn').textContent = authMode === 'signup' ? 'Create Account' : 'Sign In';
  document.getElementById('authToggleText').textContent = authMode === 'signup' ? 'Already have an account? ' : "Don't have an account? ";
  document.getElementById('authToggleLink').textContent = authMode === 'signup' ? 'Sign In' : 'Sign Up';
  document.getElementById('authError').style.display = 'none';
}

async function submitEmailAuth() {
  const email = document.getElementById('authEmail').value.trim().toLowerCase();
  const password = document.getElementById('authPassword').value;
  const confirm = document.getElementById('authPasswordConfirm').value;
  const errorEl = document.getElementById('authError');

  if (!email || !email.includes('@')) { errorEl.textContent = 'Enter a valid email.'; errorEl.style.display = 'block'; return; }
  if (password.length < 6) { errorEl.textContent = 'Password must be at least 6 characters.'; errorEl.style.display = 'block'; return; }
  if (authMode === 'signup' && password !== confirm) { errorEl.textContent = 'Passwords do not match.'; errorEl.style.display = 'block'; return; }

  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;
  btn.textContent = authMode === 'signup' ? 'Creating...' : 'Signing in...';

  try {
    const res = await fetch('/api/email-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, mode: authMode }),
    });
    const data = await res.json();

    if (data.success && data.user) {
      currentUser = data.user;
      localStorage.setItem('pc_user', JSON.stringify(data.user));
      localStorage.setItem('pc_pro_email', data.user.email);
      updateUserUI();
      closeAuthModal();
      showToast('Signed in as ' + (data.user.name || data.user.email) + '!');
      await syncPortfoliosFromCloud();
    } else {
      errorEl.textContent = data.error || 'Authentication failed.';
      errorEl.style.display = 'block';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Try again.';
    errorEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = authMode === 'signup' ? 'Create Account' : 'Sign In';
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
  updateUserUI();
  showToast('Signed out.');
}

// ── CLOUD PORTFOLIO SYNC ────────────────────────────────
async function savePortfolioToCloud(name, holdingsData) {
  if (!currentUser || !isProUser()) return null;
  try {
    const res = await fetch('/api/portfolios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch('/api/portfolios?userId=' + currentUser.id);
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
window.savePortfolio = function() {
  // Call original save (to localStorage)
  if (typeof origSavePortfolio === 'function') origSavePortfolio();

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
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window._googleScriptLoaded = true;
      if (typeof initGoogleSignIn === 'function') initGoogleSignIn();
      resolve();
    };
    document.head.appendChild(script);
  });
}
function showAuthModalOptimized() {
  if (typeof showAuthModal === 'function') showAuthModal();
  loadGoogleSignInScript(); // load Google script lazily alongside
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
