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

// ── BOTTOM NAV BAR ────────────────────────────────────────
function _setActiveTab(tabId) {
  document.querySelectorAll('.bottom-bar-tab').forEach(function(b) {
    b.classList.toggle('active', b.id === tabId);
  });
}

function _closeAllPanels() {
  closePortfolioDrawer();
  _closeNavPanel('marketPanel');
  _closeNavPanel('explorePanel');
  _closeNavPanel('chartsPanel');
}

window.navTo = function(tab) {
  if (tab === 'portfolios') {
    _closeNavPanel('marketPanel');
    _closeNavPanel('explorePanel');
    togglePortfolioDrawer();
  } else if (tab === 'market') {
    _closeAllPanels();
    _setActiveTab('navMarket');
    openMarketPanel();
  } else if (tab === 'charts') {
    _closeAllPanels();
    _setActiveTab('navCharts');
    navToCharts();
  } else if (tab === 'explore') {
    _closeAllPanels();
    _setActiveTab('navExplore');
    openExplorePanel();
  } else if (tab === 'analysis') {
    _closeAllPanels();
    _setActiveTab('navAnalysis');
    navToAnalysis();
  } else if (tab === 'user') {
    _closeAllPanels();
    if (typeof toggleSidebar === 'function') toggleSidebar();
  }
};

// ── SHARED NAV PANEL HELPERS ─────────────────────────────
function _getOrCreatePanel(id) {
  var el = document.getElementById(id);
  if (el) return el;
  el = document.createElement('div');
  el.id = id;
  el.className = 'nav-panel-overlay';
  el.addEventListener('click', function(e) {
    if (e.target === el) _closeNavPanel(id);
  });
  document.body.appendChild(el);
  return el;
}

function _closeNavPanel(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('open');
  _setActiveTab('navPortfolios');
}

// ── MARKET PANEL ─────────────────────────────────────────
function openMarketPanel() {
  var overlay = _getOrCreatePanel('marketPanel');
  var mkt = typeof getMarketStatus === 'function' ? getMarketStatus() : {};
  var mktLabel = mkt.isOpen ? 'Market Open' : mkt.isPrePost ? 'Pre/Post Market' : 'Market Closed';
  var dotCls = mkt.isOpen ? 'live' : '';

  var html = '<div class="nav-panel">'
    + '<div class="nav-panel-header">'
    + '<span class="nav-panel-title">Market Overview</span>'
    + '<button class="nav-panel-close" onclick="_closeNavPanel(\'marketPanel\')">\u2715</button>'
    + '</div>'
    + '<div class="nav-panel-body">'
    + '<div class="market-status-card">'
    + '<div class="market-status-dot ' + dotCls + '"></div>'
    + '<div><div class="market-status-label">' + mktLabel + '</div>'
    + '<div class="market-status-sub">' + new Date().toLocaleDateString([], {weekday:'long', month:'short', day:'numeric'}) + '</div></div>'
    + '</div>'
    + '<div class="market-section-label">' + (mkt.isOpen ? 'Today\'s Movers' : 'Daily Movers (Last Session)') + '</div>'
    + '<div id="marketPanelMovers"><div class="spark-shimmer" style="height:40px;border-radius:8px;margin-bottom:8px;"></div><div class="spark-shimmer" style="height:40px;border-radius:8px;"></div></div>'
    + '</div></div>';

  overlay.innerHTML = html;
  overlay.classList.add('open');

  // Load movers
  fetchTopMovers().then(function(movers) {
    var el = document.getElementById('marketPanelMovers');
    if (!el || !movers) {
      if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px 0;">No data available</div>';
      return;
    }
    var gainers = movers.gainers || [];
    var losers = movers.losers || [];
    if (gainers.length === 0 && losers.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px 0;">No data available</div>';
      return;
    }
    function moverRow(m) {
      var cls = m.changePct > 0.05 ? 'up' : m.changePct < -0.05 ? 'down' : 'flat';
      var sign = m.changePct > 0 ? '+' : '';
      return '<div class="market-mover-row">'
        + '<span class="market-mover-ticker">' + escapeHTML(m.ticker) + '</span>'
        + '<span class="market-mover-name">' + escapeHTML(m.name || '') + '</span>'
        + (m.price ? '<span class="market-mover-price">$' + m.price.toFixed(2) + '</span>' : '')
        + '<span class="market-mover-change ' + cls + '">' + sign + m.changePct.toFixed(2) + '%</span>'
        + '</div>';
    }
    var rows = '';
    if (gainers.length > 0) {
      rows += '<div class="market-section-label" style="margin-top:0;">Top Gainers</div>';
      for (var i = 0; i < gainers.length; i++) rows += moverRow(gainers[i]);
    }
    if (losers.length > 0) {
      rows += '<div class="market-section-label" style="margin-top:12px;">Top Losers</div>';
      for (var j = 0; j < losers.length; j++) rows += moverRow(losers[j]);
    }
    el.innerHTML = rows;
  });
}

// ── CHARTS NAV ───────────────────────────────────────────
function navToCharts() {
  _closeAllPanels();
  _setActiveTab('navCharts');
  // Open a panel with daily movers + portfolio charts
  var overlay = _getOrCreatePanel('chartsPanel');
  var html = '<div class="nav-panel">'
    + '<div class="nav-panel-header">'
    + '<span class="nav-panel-title">Charts</span>'
    + '<button class="nav-panel-close" onclick="_closeNavPanel(\'chartsPanel\')">\u2715</button>'
    + '</div>'
    + '<div class="nav-panel-body">';

  // Portfolio charts shortcut
  if (typeof holdings !== 'undefined' && holdings.length >= 3) {
    html += '<button class="explore-sector-card" style="width:100%;margin-bottom:14px;justify-content:center;" onclick="_closeNavPanel(\'chartsPanel\');if(typeof setHoldingsView===\'function\')setHoldingsView(\'chart\');var el=document.getElementById(\'stockList\');if(el)el.scrollIntoView({behavior:\'smooth\',block:\'start\'});">'
      + '<span class="explore-sector-name">View My Portfolio Charts</span>'
      + '</button>';
  }

  // Daily movers section
  html += '<div class="market-section-label">Daily Movers</div>'
    + '<div id="chartsPanelMovers"><div class="spark-shimmer" style="height:40px;border-radius:8px;margin-bottom:8px;"></div><div class="spark-shimmer" style="height:40px;border-radius:8px;"></div></div>'
    + '</div></div>';

  overlay.innerHTML = html;
  overlay.classList.add('open');

  // Load movers
  fetchTopMovers().then(function(movers) {
    var el = document.getElementById('chartsPanelMovers');
    if (!el) return;
    if (!movers) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px 0;">No data available</div>';
      return;
    }
    var gainers = movers.gainers || [];
    var losers = movers.losers || [];
    if (gainers.length === 0 && losers.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px 0;">No data available</div>';
      return;
    }
    function moverRow(m) {
      var cls = m.changePct > 0.05 ? 'up' : m.changePct < -0.05 ? 'down' : 'flat';
      var sign = m.changePct > 0 ? '+' : '';
      return '<div class="market-mover-row">'
        + '<span class="market-mover-ticker">' + escapeHTML(m.ticker) + '</span>'
        + '<span class="market-mover-name">' + escapeHTML(m.name || '') + '</span>'
        + (m.price ? '<span class="market-mover-price">$' + m.price.toFixed(2) + '</span>' : '')
        + '<span class="market-mover-change ' + cls + '">' + sign + m.changePct.toFixed(2) + '%</span>'
        + '</div>';
    }
    var rows = '';
    if (gainers.length > 0) {
      rows += '<div class="market-section-label" style="margin-top:0;">Top Gainers</div>';
      for (var i = 0; i < gainers.length; i++) rows += moverRow(gainers[i]);
    }
    if (losers.length > 0) {
      rows += '<div class="market-section-label" style="margin-top:12px;">Top Losers</div>';
      for (var j = 0; j < losers.length; j++) rows += moverRow(losers[j]);
    }
    el.innerHTML = rows;
  });
}

// ── ANALYSIS NAV ─────────────────────────────────────────
function navToAnalysis() {
  var results = document.getElementById('resultsPanel');
  if (results && results.querySelector('.health-panel')) {
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (typeof holdings !== 'undefined' && holdings.length > 0) {
    // Trigger analysis if holdings exist but haven't been analyzed
    if (typeof analyze === 'function') analyze();
  } else {
    showToast('Add holdings first, then analyze');
  }
  setTimeout(function() { _setActiveTab('navPortfolios'); }, 300);
}

// ── EXPLORE PANEL ────────────────────────────────────────
var _exploreSectorView = null; // which sector is drilled into

function openExplorePanel() {
  _exploreSectorView = null;
  var overlay = _getOrCreatePanel('explorePanel');
  _renderExploreContent(overlay);
  overlay.classList.add('open');
}

function _renderExploreContent(overlay) {
  if (!overlay) overlay = document.getElementById('explorePanel');
  if (!overlay) return;

  var html = '<div class="nav-panel">'
    + '<div class="nav-panel-header">'
    + '<span class="nav-panel-title">Explore Stocks</span>'
    + '<button class="nav-panel-close" onclick="_closeNavPanel(\'explorePanel\')">\u2715</button>'
    + '</div>'
    + '<div class="nav-panel-body">';

  if (_exploreSectorView) {
    // Drill-down: show stocks in this sector
    html += _renderExploreSectorDrill(_exploreSectorView);
  } else {
    // Search bar
    html += '<input class="explore-search-input" id="exploreSearchInput" type="text" placeholder="Search ticker or company..." oninput="_onExploreSearch(this.value)"/>';
    html += '<div id="exploreSearchResults"></div>';
    // Sector grid
    html += '<div class="market-section-label">Browse by Sector</div>';
    html += _renderExploreSectors();
  }

  html += '</div></div>';
  overlay.innerHTML = html;

  // Focus search if visible
  var inp = document.getElementById('exploreSearchInput');
  if (inp) setTimeout(function() { inp.focus(); }, 100);
}

function _renderExploreSectors() {
  if (typeof STOCK_DB === 'undefined' || typeof SECTOR_COLORS === 'undefined') return '';
  // Count stocks per sector
  var counts = {};
  for (var t in STOCK_DB) {
    var s = STOCK_DB[t].sector || 'Other';
    counts[s] = (counts[s] || 0) + 1;
  }
  var sectors = Object.entries(counts).sort(function(a,b) { return b[1] - a[1]; });
  var html = '<div class="explore-sector-grid">';
  for (var i = 0; i < sectors.length; i++) {
    var name = sectors[i][0];
    var count = sectors[i][1];
    var color = (typeof SECTOR_COLORS !== 'undefined' && SECTOR_COLORS[name]) || '#475569';
    html += '<div class="explore-sector-card" onclick="_exploreDrillSector(\'' + escapeHTML(name).replace(/'/g, "\\'") + '\')">'
      + '<div class="explore-sector-dot" style="background:' + color + '"></div>'
      + '<span class="explore-sector-name">' + escapeHTML(name) + '</span>'
      + '<span class="explore-sector-count">' + count + '</span>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

function _exploreDrillSector(sector) {
  _exploreSectorView = sector;
  _renderExploreContent();
}

function _exploreBackToSectors() {
  _exploreSectorView = null;
  _renderExploreContent();
}

function _renderExploreSectorDrill(sector) {
  if (typeof STOCK_DB === 'undefined') return '';
  var color = (typeof SECTOR_COLORS !== 'undefined' && SECTOR_COLORS[sector]) || '#475569';
  var html = '<button class="explore-back-btn" onclick="_exploreBackToSectors()">\u2190 All Sectors</button>';
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">'
    + '<div class="explore-sector-dot" style="background:' + color + ';width:10px;height:10px;"></div>'
    + '<span style="font-family:\'DM Sans\',sans-serif;font-size:15px;font-weight:700;color:var(--text);">' + escapeHTML(sector) + '</span>'
    + '</div>';
  // List stocks in this sector
  var stocks = [];
  for (var t in STOCK_DB) {
    if (STOCK_DB[t].sector === sector) {
      stocks.push({ ticker: t, name: STOCK_DB[t].name || t, cap: STOCK_DB[t].cap || '' });
    }
  }
  // Sort: mega > large > mid > small, then alphabetical
  var capOrder = { mega: 0, large: 1, mid: 2, small: 3, unknown: 4 };
  stocks.sort(function(a,b) {
    var ca = capOrder[a.cap] !== undefined ? capOrder[a.cap] : 4;
    var cb = capOrder[b.cap] !== undefined ? capOrder[b.cap] : 4;
    if (ca !== cb) return ca - cb;
    return a.ticker.localeCompare(b.ticker);
  });
  html += '<div class="explore-stock-list">';
  for (var i = 0; i < stocks.length; i++) {
    var s = stocks[i];
    html += '<div class="explore-stock-row" onclick="_exploreAddStock(\'' + escapeHTML(s.ticker) + '\')">'
      + '<span class="explore-stock-ticker">' + escapeHTML(s.ticker) + '</span>'
      + '<span class="explore-stock-name">' + escapeHTML(s.name) + '</span>'
      + (s.cap ? '<span class="explore-stock-sector">' + escapeHTML(s.cap) + '</span>' : '')
      + '</div>';
  }
  html += '</div>';
  return html;
}

function _onExploreSearch(query) {
  var el = document.getElementById('exploreSearchResults');
  if (!el) return;
  query = (query || '').trim().toUpperCase();
  if (query.length < 1) { el.innerHTML = ''; return; }
  if (typeof STOCK_DB === 'undefined') return;
  var results = [];
  for (var t in STOCK_DB) {
    var db = STOCK_DB[t];
    if (t.indexOf(query) === 0 || (db.name && db.name.toUpperCase().indexOf(query) !== -1)) {
      results.push({ ticker: t, name: db.name || t, sector: db.sector || '' });
    }
    if (results.length >= 15) break;
  }
  if (results.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">No matches</div>';
    return;
  }
  var html = '<div class="explore-stock-list">';
  for (var i = 0; i < results.length; i++) {
    var s = results[i];
    html += '<div class="explore-stock-row" onclick="_exploreAddStock(\'' + escapeHTML(s.ticker) + '\')">'
      + '<span class="explore-stock-ticker">' + escapeHTML(s.ticker) + '</span>'
      + '<span class="explore-stock-name">' + escapeHTML(s.name) + '</span>'
      + '<span class="explore-stock-sector">' + escapeHTML(s.sector) + '</span>'
      + '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function _exploreAddStock(ticker) {
  // If stock is already in holdings, just show toast
  if (typeof holdings !== 'undefined' && holdings.find(function(h) { return h.ticker === ticker; })) {
    showToast(ticker + ' already in portfolio');
    return;
  }
  // Auto-add with default 5% allocation
  var db = (typeof STOCK_DB !== 'undefined' && STOCK_DB[ticker]) || {};
  var total = typeof totalAllocation === 'function' ? totalAllocation() : 0;
  var pct = Math.min(5, Math.round((100 - total) * 10) / 10);
  if (pct <= 0) { showToast('Portfolio is full (100%)'); return; }
  holdings.push({
    ticker: ticker,
    pct: pct,
    name: db.name || ticker,
    sector: db.sector || 'Other',
    beta: db.beta || 1.0,
    cap: db.cap || 'unknown'
  });
  if (typeof renderHoldings === 'function') renderHoldings();
  showToast(ticker + ' added (' + pct + '%)');
  // Close panel
  _closeNavPanel('explorePanel');
}

// ── PORTFOLIO DRAWER (popover above Portfolios tab) ──────────
function _buildPortfolioDrawer() {
  var drawer = document.getElementById('portfolioDrawer');
  if (drawer) return drawer;
  drawer = document.createElement('div');
  drawer.id = 'portfolioDrawer';
  drawer.className = 'portfolio-drawer';
  document.body.appendChild(drawer);
  drawer.addEventListener('click', function(e) {
    if (e.target === drawer) closePortfolioDrawer();
  });
  return drawer;
}

function renderPortfolioDrawer() {
  var drawer = _buildPortfolioDrawer();
  var portfolios = getSavedPortfolios();
  var html = '<div class="pdrawer-panel">';
  html += '<div class="pdrawer-header"><span class="pdrawer-title">My Portfolios</span>'
    + '<button class="pdrawer-close" onclick="closePortfolioDrawer()">\u2715</button></div>';
  if (portfolios.length === 0) {
    html += '<div class="pdrawer-empty">No saved portfolios yet.<br>Add holdings and tap <strong>Save</strong>.</div>';
  } else {
    html += '<div class="pdrawer-list">';
    for (var i = 0; i < portfolios.length; i++) {
      var p = portfolios[i];
      var count = p.holdings ? p.holdings.length : 0;
      var isActive = (typeof _activePortfolioIdx !== 'undefined' && _activePortfolioIdx === i);
      var riskColor = typeof getPortfolioRiskColor === 'function' ? getPortfolioRiskColor(p.holdings) : 'var(--muted)';
      var perf = _lastPerfMap && _lastPerfMap[i] != null ? _lastPerfMap[i] : null;
      var perfHtml = '';
      if (perf != null) {
        var cls = perf > 0.005 ? 'up' : perf < -0.005 ? 'down' : 'flat';
        var sign = perf > 0 ? '+' : '';
        perfHtml = '<span class="pstrip-change ' + cls + '">' + sign + perf.toFixed(2) + '%</span>';
      }
      html += '<div class="pdrawer-item' + (isActive ? ' active' : '') + '" onclick="loadPortfolio(' + i + ');closePortfolioDrawer()" style="border-left-color:' + riskColor + '">'
        + '<div class="pdrawer-info"><div class="pdrawer-name">' + escapeHTML(p.name) + '</div>'
        + '<div class="pdrawer-count">' + count + ' holding' + (count !== 1 ? 's' : '') + '</div></div>'
        + perfHtml
        + '<button class="pdrawer-delete" onclick="event.stopPropagation();quickDeletePortfolio(' + i + ')" title="Delete">&times;</button>'
        + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  drawer.innerHTML = html;
}

// Direct delete without confirm (for drawer - small button = intentional)
function quickDeletePortfolio(idx) {
  var portfolios = getSavedPortfolios();
  if (!portfolios[idx]) return;
  var name = portfolios[idx].name || 'Portfolio';
  var deleted = portfolios.splice(idx, 1)[0];
  savePortfoliosLS(portfolios);
  if (typeof _activePortfolioIdx !== 'undefined' && _activePortfolioIdx === idx) {
    _activePortfolioIdx = -1;
    _activePortfolioSnapshot = null;
    // Clear loaded holdings since active portfolio was deleted
    if (typeof holdings !== 'undefined') {
      holdings.length = 0;
      if (typeof renderHoldings === 'function') renderHoldings();
      if (typeof expandInputSections === 'function') expandInputSections();
      if (typeof expandHoldingsPanel === 'function') expandHoldingsPanel();
    }
  } else if (typeof _activePortfolioIdx !== 'undefined' && _activePortfolioIdx > idx) {
    _activePortfolioIdx--;
  }
  // Clear performance cache for deleted portfolio
  if (_lastPerfMap) {
    delete _lastPerfMap[idx];
    // Reindex remaining entries
    var newMap = {};
    var keys = Object.keys(_lastPerfMap).map(Number).sort(function(a,b){return a-b;});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k > idx) newMap[k - 1] = _lastPerfMap[k];
      else if (k < idx) newMap[k] = _lastPerfMap[k];
    }
    _lastPerfMap = Object.keys(newMap).length > 0 ? newMap : null;
  }
  renderPortfolioDrawer();
  renderPortfolioStrip(_lastPerfMap);
  showToast('Deleted "' + name + '"');
  // Cloud delete
  if (deleted && deleted.cloudId && typeof currentUser !== 'undefined' && currentUser) {
    fetch('/api/portfolios?userId=' + currentUser.id + '&portfolioId=' + deleted.cloudId, {
      method: 'DELETE', credentials: 'include',
    }).catch(function() {});
  }
}

function togglePortfolioDrawer() {
  var drawer = _buildPortfolioDrawer();
  if (drawer.classList.contains('open')) {
    closePortfolioDrawer();
  } else {
    renderPortfolioDrawer();
    requestAnimationFrame(function() { drawer.classList.add('open'); });
  }
}

window.closePortfolioDrawer = function() {
  var drawer = document.getElementById('portfolioDrawer');
  if (drawer) drawer.classList.remove('open');
};

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
  window._stickyAnalyzed = false;

  function checkSticky() {
    if (holdings.length > 0 && !window._stickyAnalyzed) {
      sticky.classList.add('visible');
    } else {
      sticky.classList.remove('visible');
    }
  }

  // Hook analyze to hide sticky permanently until holdings change
  const origAnalyze = window.analyze;
  if (typeof origAnalyze === 'function') {
    window.analyze = function() {
      window._stickyAnalyzed = true;
      sticky.classList.remove('visible');
      return origAnalyze.apply(this, arguments);
    };
  }

  // Check on holdings change
  const origRender = window.renderHoldings;
  if (typeof origRender === 'function') {
    window.renderHoldings = function() {
      origRender();
      checkSticky();
    };
  }

  // Reset analyzed flag when holdings change
  const origAddStock = window.addStock;
  if (typeof origAddStock === 'function') {
    window.addStock = function() {
      window._stickyAnalyzed = false;
      return origAddStock.apply(this, arguments);
    };
  }
  const origRemoveStock = window.removeStock;
  if (typeof origRemoveStock === 'function') {
    window.removeStock = function(t) {
      window._stickyAnalyzed = false;
      return origRemoveStock.apply(this, arguments);
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
const GOOGLE_CLIENT_ID = '883221867787-46q3pisnln3qoaqro2smu8jherv3nq43.apps.googleusercontent.com';

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

function _isIPadSafari() {
  return !isIOSApp() && (
    /iPad/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function googleSignIn() {
  // iOS WebView: GIS doesn't work, use OAuth popup (intercepted by native app)
  if (isIOSApp()) {
    openGoogleOAuthPopup();
    return;
  }

  // iPad Safari: GIS popup/FedCM doesn't work reliably, use redirect flow
  if (_isIPadSafari()) {
    var nonce = Math.random().toString(36).substr(2);
    var url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=' + GOOGLE_CLIENT_ID
      + '&redirect_uri=' + encodeURIComponent(window.location.origin)
      + '&response_type=id_token'
      + '&scope=openid%20email%20profile'
      + '&nonce=' + nonce
      + '&prompt=select_account';
    window.location.href = url;
    return;
  }

  // Web: use Google Identity Services renderButton (no popup/redirect needed)
  if (typeof google === 'undefined' || !google.accounts) {
    loadGoogleSignInScript().then(() => googleSignIn()).catch(() => {
      showToast('Failed to load Google Sign-In. Please try again.');
    });
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
      closeAuthModal();
      updateUserUI();
      showToast('Signed in as ' + data.user.name + '!');

      // Auto-check Pro status (refreshes cookie, sets pc_pro_expiry)
      await verifyProAccess(data.user.email);
    } else {
      showToast('Sign in failed. Please try again.');
    }
  } catch (err) {
    console.error('Sign in error:', err);
    showToast('Sign in failed. Please try again.');
  }
}

function updateUserUI() {
  const pillName = document.getElementById('userPillName');
  const pillAvatar = document.getElementById('userPillAvatar');

  if (currentUser) {
    // Update pill — show first name + avatar
    const fullName = currentUser.name || currentUser.email.split('@')[0];
    const firstName = fullName.split(' ')[0];
    const lastInitial = fullName.split(' ').length > 1 ? ' ' + fullName.split(' ').slice(-1)[0][0] + '.' : '';
    if (pillName) pillName.textContent = firstName + lastInitial;
    if (pillAvatar) {
      if (currentUser.picture) {
        if (pillAvatar.tagName !== 'IMG') {
          const img = document.createElement('img');
          img.id = 'userPillAvatar';
          img.className = 'user-pill-avatar visible';
          img.src = currentUser.picture;
          img.onerror = function() { this.style.display = 'none'; };
          pillAvatar.replaceWith(img);
        } else {
          pillAvatar.className = 'user-pill-avatar visible';
          pillAvatar.src = currentUser.picture;
          pillAvatar.onerror = function() { this.style.display = 'none'; };
        }
      } else {
        const initial = (fullName || '?')[0].toUpperCase();
        if (pillAvatar.tagName === 'IMG') {
          const span = document.createElement('span');
          span.id = 'userPillAvatar';
          span.className = 'user-pill-avatar initials';
          span.textContent = initial;
          pillAvatar.replaceWith(span);
        } else {
          pillAvatar.className = 'user-pill-avatar initials';
          pillAvatar.textContent = initial;
        }
      }
    }
    // Hide Pro button if pro
    if (isProUser()) {
      const pb = document.getElementById('btnPro');
      if (pb) pb.style.display = 'none';
    }
  } else {
    if (pillName) pillName.textContent = '☰ Menu';
    if (pillAvatar) {
      if (pillAvatar.tagName === 'IMG') {
        const span = document.createElement('span');
        span.id = 'userPillAvatar';
        span.className = 'user-pill-avatar';
        pillAvatar.replaceWith(span);
      } else {
        pillAvatar.className = 'user-pill-avatar';
        pillAvatar.textContent = '';
      }
    }
    // Show Pro button again
    const pb = document.getElementById('btnPro');
    if (pb) pb.style.display = '';
  }
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
}

// Sidebar has its own close mechanisms (backdrop click, close button, Escape key)
// No outside-click handler needed.

function signOut() {
  // 1. Clear in-memory state immediately
  currentUser = null;
  if (typeof holdings !== 'undefined') holdings.length = 0;
  _activePortfolioIdx = -1;
  _activePortfolioSnapshot = null;
  _lastPerfMap = null;
  _topMoversCache = null;
  _proPicksCache = null;

  // 2. Explicitly remove known keys
  var explicitKeys = [
    'pc_portfolios', 'pc_user', 'pc_pro_email', 'pc_pro_expiry',
    'pc_pro_plan', 'pc_checkout_pending', 'currentUser',
    'pc_cached_analysis', 'pc_cached_analysis_ts'
  ];
  explicitKeys.forEach(function(k) { try { localStorage.removeItem(k); } catch(e) {} });

  // 3. Also clear all pc_ prefixed keys (market cache, sparkline cache, etc.)
  var keysToRemove = [];
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.startsWith('pc_') && key !== 'pc_theme' && key !== 'pc_ai_consent') {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(function(k) { try { localStorage.removeItem(k); } catch(e) {} });

  // 4. Clear HttpOnly cookies server-side
  fetch('/api/signout', { method: 'POST' }).catch(function() {});

  // 5. Hard reload to guarantee clean state
  window.location.reload();
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
  if (!currentUser) return null;
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
  try {
    const res = await fetch('/api/portfolios?userId=' + currentUser.id, {
      credentials: 'include',
    });
    const data = await res.json();
    if (data.portfolios && data.portfolios.length > 0) {
      // Replace local portfolios with cloud versions
      const cloudPortfolios = data.portfolios.map(cp => ({
        name: cp.name,
        holdings: typeof cp.holdings === 'string' ? JSON.parse(cp.holdings) : cp.holdings,
        cloudId: cp.id,
      }));
      localStorage.setItem('pc_portfolios', JSON.stringify(cloudPortfolios));
      _activePortfolioIdx = -1;
      _activePortfolioSnapshot = null;
      if (typeof renderSidebarPortfolios === 'function') renderSidebarPortfolios();
      closeSidebar();
      showToast('☁️ Synced ' + cloudPortfolios.length + ' portfolio(s) from cloud');
    } else {
      showToast('No cloud portfolios found.');
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
    // Generate nonce for replay protection (Apple recommended)
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const rawNonce = Array.from(nonceBytes, b => b.toString(16).padStart(2, '0')).join('');
    const nonceHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawNonce))), b => b.toString(16).padStart(2, '0')).join('');

    AppleID.auth.init({
      clientId: APPLE_CLIENT_ID,
      scope: 'name email',
      redirectURI: window.location.origin,
      usePopup: true,
      nonce: nonceHash,
    });
    const response = await AppleID.auth.signIn();
    const body = { id_token: response.authorization.id_token, nonce: rawNonce };
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
      closeAuthModal();
      updateUserUI();
      showToast('Signed in as ' + data.user.name + '!');
      await verifyProAccess(data.user.email);
    } else {
      showToast('Sign in failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    if (err.error === 'popup_closed_by_user') return;
    console.error('Apple Sign-In error:', err);
    showToast('Apple Sign-In failed. Please try again.');
  }
}

// ── COLLAPSE HOLDINGS AFTER ANALYZE ───────────────────────────
// After analysis, collapse the holdings editing panel with smooth animation
function collapseHoldingsPanel(mobileOnly) {
  if (mobileOnly && window.innerWidth > 900) return;
  var body = document.getElementById('holdingsBody');
  var link = document.getElementById('editPortfolioLink');
  var chevron = document.getElementById('holdingsChevron');
  if (!body || body.classList.contains('collapsed')) return;
  body.style.maxHeight = body.scrollHeight + 'px';
  body.offsetHeight; // force reflow
  body.classList.add('collapsed');
  body.style.maxHeight = '0';
  if (link) link.style.display = 'inline';
  if (chevron) chevron.textContent = '▸';
}

function expandHoldingsPanel() {
  var body = document.getElementById('holdingsBody');
  var link = document.getElementById('editPortfolioLink');
  var chevron = document.getElementById('holdingsChevron');
  if (!body || !body.classList.contains('collapsed')) return;
  body.classList.remove('collapsed');
  body.style.maxHeight = body.scrollHeight + 'px';
  var done = function() { body.style.maxHeight = ''; body.removeEventListener('transitionend', done); };
  body.addEventListener('transitionend', done);
  if (link) link.style.display = 'none';
  if (chevron) chevron.textContent = '▾';
}

// Briefly highlight the What-If simulator after first analysis
function highlightWhatIf() {
  var panel = document.getElementById('whatifPanel');
  if (!panel || panel.dataset.promoted) return;
  panel.dataset.promoted = '1';
  panel.classList.add('whatif-promoted');
  setTimeout(function() {
    panel.classList.remove('whatif-promoted');
  }, 5000);
}

// Hook into analyze() to highlight what-if after analysis completes
(function() {
  var origAnalyze = window.analyze;
  if (typeof origAnalyze === 'function') {
    window.analyze = function() {
      origAnalyze.apply(this, arguments);
      highlightWhatIf();
    };
  }
})();

// ── PATCH 0: FETCH FRESH BETAS & PICKS FROM DAILY CRON ───────
// Merges server-computed betas (Yahoo Finance 6mo) and stock picks
// into the static STOCK_DB and STOCK_PICKS from data.js.
// Falls back silently to static values on any failure.
(async function loadFreshStockData() {
  try {
    const res = await fetch('/api/stock-data');
    if (!res.ok) return;
    const data = await res.json();

    // Merge betas into STOCK_DB
    if (data.betas && typeof data.betas === 'object') {
      let updated = 0;
      for (const [ticker, beta] of Object.entries(data.betas)) {
        if (typeof STOCK_DB !== 'undefined' && STOCK_DB[ticker] && typeof beta === 'number') {
          STOCK_DB[ticker].beta = beta;
          updated++;
        }
      }
      if (updated > 0) console.log('[stock-data] Updated ' + updated + ' betas from server');
    }

    // Merge picks into STOCK_PICKS (replace contents in-place)
    if (data.picks && Array.isArray(data.picks) && data.picks.length > 0 && typeof STOCK_PICKS !== 'undefined') {
      STOCK_PICKS.length = 0;
      for (const pick of data.picks) {
        STOCK_PICKS.push(pick);
      }
      console.log('[stock-data] Loaded ' + data.picks.length + ' fresh picks');
    }
  } catch (e) {
    // Silent fallback — static data.js values remain
    console.warn('[stock-data] Failed to load fresh data, using static defaults');
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
    if (!res.ok) {
      console.warn('[market-data] API returned', res.status);
      return null;
    }
    const raw = await res.json();
    if (raw.error) {
      console.warn('[market-data] API error:', raw.error);
      return null;
    }
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

// ── PATCH 2: ANALYZE DEBOUNCE + BUTTON LOCK ──────────────────
let analyzeDebounceTimer = null;
let _analyzeLocked = false;
function analyzeDebounced() {
  if (_analyzeLocked) return;
  if (typeof holdings !== 'undefined' && holdings.length === 0) {
    showToast('Please add holdings first');
    return;
  }
  clearTimeout(analyzeDebounceTimer);
  analyzeDebounceTimer = setTimeout(() => {
    _analyzeLocked = true;
    var selectors = ['#analyzeBtn', '.btn-analyze-sticky', '#refreshMarketBtn'];
    var analyzeBtn = document.getElementById('analyzeBtn');
    if (analyzeBtn) analyzeBtn.classList.add('analyzing');
    selectors.forEach(function(s) {
      var el = document.querySelector(s);
      if (el) { el.disabled = true; el.style.opacity = '0.5'; }
    });
    try { analyze(); } catch(e) { console.error(e); }
    collapseHoldingsPanel();
    // Unlock after market data fetch completes (max 8s safety timeout)
    setTimeout(function() {
      _analyzeLocked = false;
      if (analyzeBtn) analyzeBtn.classList.remove('analyzing');
      selectors.forEach(function(s) {
        var el = document.querySelector(s);
        if (el) { el.disabled = false; el.style.opacity = ''; }
      });
    }, 8000);
  }, 300);
}

// ── SAVE BUTTON LOCK ─────────────────────────────────────────
(function lockSaveButtons() {
  var origSave = window.savePortfolio;
  if (typeof origSave !== 'function') return;
  window.savePortfolio = function() {
    var btns = document.querySelectorAll('#btnQuickSave');
    btns.forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
    try { origSave.apply(this, arguments); } catch(e) { console.error(e); }
    setTimeout(function() {
      btns.forEach(function(b) { b.disabled = false; b.style.opacity = ''; });
    }, 2000);
  };
})();

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
  var keys = ['monthly', 'annual', 'lifetime'];
  keys.forEach(function(k) {
    var el = document.getElementById('tier-' + k);
    if (!el) return;
    if (k === tier) {
      el.classList.add('pw-tier-selected');
    } else {
      el.classList.remove('pw-tier-selected');
    }
  });
  var btn = document.getElementById('paywallConfirmBtn');
  var t = paywallTiers[tier];
  if (btn && t) {
    btn.textContent = t.label;
    btn.onclick = function() { goToPurchase(t.url); };
  }
}

// Event delegation — clicks anywhere inside a tier bubble up here
(function() {
  var container = document.getElementById('pwTiers');
  if (!container) return;
  container.addEventListener('click', function(e) {
    var tier = e.target.closest('.pw-tier');
    if (tier && tier.dataset.tier) {
      selectPaywallTier(tier.dataset.tier);
    }
  });
})();

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

// Sub-bar removed — portfolios are now in the sidebar.

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
    if (pwPrices[0]) pwPrices[0].innerHTML = S.monthly.price + '<span style="font-size:10px;color:#6b7a90;">' + S.monthly.period + '</span>';
    if (pwPrices[1]) pwPrices[1].innerHTML = S.annual.price + '<span style="font-size:10px;color:#6b7a90;">' + S.annual.period + '</span>';
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

// ── PORTFOLIO STRIP ─────────────────────────────────────────

var _lastPerfMap = null; // cache last successful performance data
var _topMoversCache = null; // cached top movers data

// Broad universe of popular high-volume stocks across all sectors
// Split into 2 batches of ≤40 (API hard cap) to find actual daily top movers
var _moverTickersA = [
  'NVDA','TSLA','AAPL','MSFT','AMD','META','AMZN','GOOGL','AVGO','ORCL',
  'CRM','ADBE','INTC','CSCO','QCOM','PLTR','MU','MRVL','ARM','SMCI',
  'JPM','GS','V','MA','PYPL','SQ','COIN','HOOD','SOFI','WMT',
  'COST','NKE','DIS','NFLX','ABNB','JNJ','UNH','PFE','LLY','MRK'
];
var _moverTickersB = [
  'XOM','CVX','COP','OXY','AI','SOUN','DDOG','CRWD','PANW','NET',
  'RIVN','LCID','NIO','F','GM','RDDT','SNAP','SPOT','ROKU','MARA',
  'RIOT','MSTR','BA','LMT','CAT','GE','APP','UBER','DASH','RBLX',
  'AFRM','UPST','MRNA','AMGN','ABBV','BMY','SLB','SHOP','SNOW','TXN'
];

function _renderMoversHTML(movers) {
  if (!movers) return '';
  // Support new { gainers, losers } format
  var gainers = movers.gainers || [];
  var losers = movers.losers || [];
  if (gainers.length === 0 && losers.length === 0) return '';
  var html = '';
  function renderRow(m) {
    var cls = m.changePct > 0.05 ? 'up' : m.changePct < -0.05 ? 'down' : 'flat';
    var sign = m.changePct > 0 ? '+' : '';
    return '<div class="pstrip-mover" title="' + escapeHTML(m.name || m.ticker) + '">'
      + '<span class="pstrip-mover-ticker">' + escapeHTML(m.ticker) + '</span>'
      + '<span class="pstrip-change ' + cls + '">' + sign + m.changePct.toFixed(1) + '%</span>'
      + '</div>';
  }
  if (gainers.length > 0) {
    html += '<div class="pstrip-movers-label">Top Gainers</div>';
    for (var i = 0; i < gainers.length; i++) html += renderRow(gainers[i]);
  }
  if (losers.length > 0) {
    html += '<div class="pstrip-movers-label" style="margin-top:4px;">Top Losers</div>';
    for (var j = 0; j < losers.length; j++) html += renderRow(losers[j]);
  }
  return html;
}

function fetchTopMovers() {
  // Use cached data if fresh (15 min)
  if (_topMoversCache && (Date.now() - _topMoversCache.ts < 15 * 60 * 1000)) {
    return Promise.resolve(_topMoversCache.data);
  }
  if (typeof fetchMarketDataCached !== 'function') return Promise.resolve(null);
  // Fetch both batches in parallel through existing market-data cache
  return Promise.all([
    fetchMarketDataCached(_moverTickersA),
    fetchMarketDataCached(_moverTickersB)
  ]).then(function(results) {
    var md = Object.assign({}, results[0] || {}, results[1] || {});
    var gainers = [];
    var losers = [];
    for (var t in md) {
      if (md[t] && md[t].changePct != null) {
        var entry = { ticker: t, changePct: md[t].changePct, name: md[t].name || t, price: md[t].price || 0 };
        if (md[t].changePct > 0.01) gainers.push(entry);
        else if (md[t].changePct < -0.01) losers.push(entry);
      }
    }
    // Sort gainers descending, losers ascending (most negative first)
    gainers.sort(function(a, b) { return b.changePct - a.changePct; });
    losers.sort(function(a, b) { return a.changePct - b.changePct; });
    var top = { gainers: gainers.slice(0, 3), losers: losers.slice(0, 3) };
    _topMoversCache = { data: top, ts: Date.now() };
    return top;
  }).catch(function() { return null; });
}

function renderPortfolioStrip(performanceMap) {
  var strip = document.getElementById('portfolioStrip');
  if (!strip) return;
  var portfolios = getSavedPortfolios();

  // Use last known data as fallback so we don't flash "•••"
  var pm = performanceMap || _lastPerfMap;
  if (performanceMap) _lastPerfMap = performanceMap;

  var html = '';

  // Top movers section (always shown)
  if (_topMoversCache && _topMoversCache.data && (_topMoversCache.data.gainers || _topMoversCache.data.losers)) {
    html += _renderMoversHTML(_topMoversCache.data);
  }

  // Portfolio cards (if any)
  if (portfolios.length > 0) {
    if (_topMoversCache && _topMoversCache.data && (_topMoversCache.data.gainers || _topMoversCache.data.losers)) {
      html += '<div class="pstrip-divider"></div>';
    }
    for (var i = 0; i < portfolios.length; i++) {
      var p = portfolios[i];
      var count = p.holdings ? p.holdings.length : 0;
      var isActive = (typeof _activePortfolioIdx !== 'undefined' && _activePortfolioIdx === i);
      var riskColor = typeof getPortfolioRiskColor === 'function' ? getPortfolioRiskColor(p.holdings) : 'var(--muted)';
      var changeBadge;
      if (pm && pm[i] != null) {
        var val = pm[i];
        var cls = val > 0.005 ? 'up' : val < -0.005 ? 'down' : 'flat';
        var sign = val > 0 ? '+' : '';
        changeBadge = '<span class="pstrip-change ' + cls + '">' + sign + val.toFixed(2) + '%</span>';
      } else {
        changeBadge = '<span class="pstrip-change loading">\u2022\u2022\u2022</span>';
      }
      html += '<div class="pstrip-card' + (isActive ? ' active' : '') + '" onclick="loadPortfolio(' + i + ')" title="' + escapeHTML(p.name) + '" style="border-left-color:' + riskColor + '">'
        + '<div class="pstrip-info"><div class="pstrip-name">' + escapeHTML(p.name) + '</div>'
        + '<div class="pstrip-count">' + count + ' holding' + (count !== 1 ? 's' : '') + '</div></div>'
        + changeBadge
        + '</div>';
    }
  }

  // Market status + last refreshed
  var mkt = typeof getMarketStatus === 'function' ? getMarketStatus() : {};
  var mktLabel = mkt.isOpen ? 'Market Open' : mkt.isPrePost ? 'Pre/Post' : 'Market Closed';
  var mktDot = mkt.isOpen ? 'live' : '';
  var lastRefresh = (_lastPerfMap || _topMoversCache) ? new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
  html += '<div class="pstrip-status">'
    + '<span class="pstrip-market ' + mktDot + '">&#9679; ' + mktLabel + '</span>'
    + (lastRefresh ? '<span class="pstrip-updated">' + lastRefresh + '</span>' : '')
    + '</div>';
  html += '<button class="pstrip-refresh" id="pstripRefresh" onclick="refreshPortfolioStrip()" title="Refresh prices">\u21bb</button>';
  strip.innerHTML = html;
  strip.classList.add('visible');
}

function _collectPortfolioTickers() {
  var portfolios = getSavedPortfolios();
  var tickerSet = {};
  for (var i = 0; i < portfolios.length; i++) {
    var h = portfolios[i].holdings;
    if (!h) continue;
    for (var j = 0; j < h.length; j++) {
      if (h[j].ticker) tickerSet[h[j].ticker.toUpperCase()] = true;
    }
  }
  return Object.keys(tickerSet);
}

async function fetchPortfolioPerformance(forceRefresh) {
  var portfolios = getSavedPortfolios();
  if (portfolios.length === 0) return null;
  var tickers = _collectPortfolioTickers();
  if (tickers.length === 0) return null;
  // Bust localStorage cache if force-refreshing
  if (forceRefresh) {
    // Clear all chunk caches
    for (var ci = 0; ci < tickers.length; ci += 40) {
      var chunk = tickers.slice(ci, ci + 40);
      var cacheKey = 'pc_market_' + chunk.slice().sort().join(',');
      try { localStorage.removeItem(cacheKey); } catch(e) {}
    }
  }
  // Fetch in batches of 40 (API hard cap)
  var marketData = {};
  for (var ci = 0; ci < tickers.length; ci += 40) {
    var chunk = tickers.slice(ci, ci + 40);
    var chunkData = await fetchMarketDataCached(chunk);
    if (chunkData) Object.assign(marketData, chunkData);
  }
  if (Object.keys(marketData).length === 0) return null;
  // Calculate weighted daily change for each portfolio
  var perfMap = {};
  for (var i = 0; i < portfolios.length; i++) {
    var h = portfolios[i].holdings;
    if (!h || h.length === 0) { perfMap[i] = 0; continue; }
    var totalPct = 0;
    var weightedChange = 0;
    for (var j = 0; j < h.length; j++) {
      var ticker = (h[j].ticker || '').toUpperCase();
      var pct = Number(h[j].pct) || 0;
      var md = marketData[ticker];
      if (md && md.changePct != null) {
        weightedChange += (pct / 100) * md.changePct;
      }
      totalPct += pct;
    }
    perfMap[i] = totalPct > 0 ? weightedChange : 0;
  }
  return perfMap;
}

window.refreshPortfolioStrip = async function() {
  var btn = document.getElementById('pstripRefresh');
  if (btn) {
    btn.classList.remove('spin-once');
    void btn.offsetWidth; // force reflow to restart animation
    btn.classList.add('spin-once');
    btn.disabled = true;
  }
  try {
    // Refresh top movers
    _topMoversCache = null;
    await fetchTopMovers();
    var tickers = _collectPortfolioTickers();
    console.log('[portfolio-strip] refreshing', tickers.length, 'tickers');
    var pm = await fetchPortfolioPerformance(true);
    if (pm) {
      renderPortfolioStrip(pm);
      showToast('\u2713 Prices updated');
    } else {
      renderPortfolioStrip(null);
      showToast('\u2713 Movers updated');
    }
  } catch(e) {
    console.warn('[portfolio-strip] refresh failed:', e);
    showToast('Refresh failed');
  }
  btn = document.getElementById('pstripRefresh');
  if (btn) { btn.classList.remove('spin-once'); btn.disabled = false; }
};

// Initialize portfolio strip on page load
(function initPortfolioStrip() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  function boot() {
    renderPortfolioStrip(null);
    // Fetch top movers first (always), then portfolio performance
    fetchTopMovers().then(function() {
      renderPortfolioStrip(null);
      return fetchPortfolioPerformance();
    }).then(function(perfMap) {
      if (perfMap) renderPortfolioStrip(perfMap);
    }).catch(function() {});
  }
})();

// Hook into existing functions to refresh the strip
(function hookPortfolioStrip() {
  // Helper: re-render strip then fetch fresh data in background
  function refreshStrip() {
    renderPortfolioStrip(null); // re-render immediately with cached data
    fetchPortfolioPerformance().then(function(pm) {
      if (pm) renderPortfolioStrip(pm);
    }).catch(function() {});
  }
  // Helper: re-render strip (active highlight etc) without refetching
  function refreshStripCheap() {
    renderPortfolioStrip(null); // uses _lastPerfMap fallback
  }

  // Wrap savePortfolio (already wrapped once for cloud sync)
  var prevSave = window.savePortfolio;
  window.savePortfolio = async function() {
    if (typeof prevSave === 'function') await prevSave();
    refreshStrip();
  };

  // Wrap deletePortfolio
  var prevDelete = window.deletePortfolio;
  window.deletePortfolio = function(idx) {
    if (typeof prevDelete === 'function') prevDelete(idx);
    refreshStrip();
  };

  // Wrap loadPortfolio
  var prevLoad = window.loadPortfolio;
  window.loadPortfolio = function(idx) {
    if (typeof prevLoad === 'function') prevLoad(idx);
    refreshStripCheap();
  };

  // Wrap renamePortfolio
  var prevRename = window.renamePortfolio;
  window.renamePortfolio = function(idx, newName) {
    if (typeof prevRename === 'function') prevRename(idx, newName);
    refreshStripCheap();
  };

  // Wrap clearAllHoldings
  var prevClear = window.clearAllHoldings;
  window.clearAllHoldings = function() {
    if (typeof prevClear === 'function') prevClear();
    renderPortfolioStrip(null);
    fetchPortfolioPerformance().then(function(pm) { renderPortfolioStrip(pm); }).catch(function() {});
  };

  // Wrap syncPortfoliosFromCloud
  var prevSync = window.syncPortfoliosFromCloud;
  window.syncPortfoliosFromCloud = async function() {
    if (typeof prevSync === 'function') await prevSync();
    refreshStrip();
  };
})();
