// ── HEADER — always compact (set via class in HTML) ─────────────────────────

function escapeHTML(str) {
  if (typeof str !== 'string') return String(str);
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── AI DATA-SHARING CONSENT (Apple Guideline 5.1.2(i)) ──────────────────────
// Must obtain explicit consent before sending data to Anthropic (Claude AI)
function hasAIConsent() {
  return localStorage.getItem('pc_ai_consent') === 'yes';
}

function showAIConsentDialog() {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.id = 'aiConsentOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100000;padding:16px;';
    overlay.innerHTML =
      '<div style="background:#131720;border:1px solid #2a3040;border-radius:14px;max-width:380px;width:100%;padding:24px;text-align:center;">' +
        '<div style="font-size:32px;margin-bottom:12px;">🤖</div>' +
        '<h3 style="color:#fff;font-family:\'DM Sans\',sans-serif;font-size:17px;margin:0 0 8px;">AI Data Disclosure</h3>' +
        '<p style="color:#8a9ab8;font-family:\'DM Sans\',sans-serif;font-size:13px;line-height:1.5;margin:0 0 6px;">' +
          'Portfolio Compass uses <strong style="color:#c5cee0;">Anthropic (Claude AI)</strong> to analyze your portfolio.' +
        '</p>' +
        '<p style="color:#8a9ab8;font-family:\'DM Sans\',sans-serif;font-size:13px;line-height:1.5;margin:0 0 16px;">' +
          'Your stock holdings and portfolio data will be sent to Anthropic\'s servers for analysis. ' +
          'Anthropic does not use this data for model training. ' +
          '<a href="/privacy.html" target="_blank" style="color:#6c63ff;">Privacy Policy</a>' +
        '</p>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="aiConsentDecline" style="flex:1;padding:10px;border-radius:8px;border:1px solid #2a3040;background:none;color:#8a9ab8;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;cursor:pointer;">Decline</button>' +
          '<button id="aiConsentAccept" style="flex:1;padding:10px;border-radius:8px;border:none;background:#6c63ff;color:#fff;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;cursor:pointer;">Allow</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('aiConsentAccept').onclick = function() {
      localStorage.setItem('pc_ai_consent', 'yes');
      overlay.remove();
      resolve(true);
    };
    document.getElementById('aiConsentDecline').onclick = function() {
      overlay.remove();
      resolve(false);
    };
  });
}

// ── CLAUDE API HELPER (defined first so all functions can use it) ─────────────
// Sends pro token + email + timestamp so server can verify Pro server-side
async function callClaudeAPI(body) {
  // Check AI consent before sending any data to Anthropic
  if (!hasAIConsent()) {
    var consented = await showAIConsentDialog();
    if (!consented) {
      throw new Error('AI_CONSENT_DECLINED');
    }
  }
  return fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}


// ── PRO FEATURE CHECK HELPER ─────────────────────────────
// Calls /api/check-feature to verify Pro status server-side
// Returns: 'allowed', 'denied', or 'auth_expired'
async function callCheckFeature(feature) {
  try {
    const res = await fetch('/api/check-feature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature }),
    });
    if (res.status === 401) return 'auth_expired';
    if (!res.ok) return 'denied';
    const data = await res.json();
    return data.allowed === true ? 'allowed' : 'denied';
  } catch (e) {
    console.warn('[check-feature] request failed:', e.message);
    return 'denied'; // fail closed
  }
}

// ── PRO PICKS FETCH HELPER ──────────────────────────────
// Fetches extended stock/ETF picks from /api/pro-picks (Pro only)
let _proPicksCache = null;
async function fetchProPicks() {
  if (_proPicksCache) return _proPicksCache;
  try {
    const res = await fetch('/api/pro-picks');
    if (!res.ok) return null;
    const data = await res.json();
    _proPicksCache = data;
    return data;
  } catch (e) {
    console.warn('[pro-picks] fetch failed:', e.message);
    return null;
  }
}

// ── STATE ────────────────────────────────────────────────
let holdings = [];
let previewHoldings = [];
let _activePortfolioIdx = -1;
let _activePortfolioSnapshot = null;
let _holdingsView = 'chart';


// ── HOLDINGS LOGIC ───────────────────────────────────────
// Cached market prices for equity calculations
var _holdingsPriceCache = {};

function totalAllocation() {
  return Math.round(holdings.reduce((s, h) => s + (h.pct || 0), 0) * 10) / 10;
}

// Recalculate pct for each holding based on equity (shares × price)
function recalcPortfolioPct(marketData) {
  if (marketData) {
    for (var t in marketData) {
      if (marketData[t] && marketData[t].price) _holdingsPriceCache[t] = marketData[t].price;
    }
  }
  var totalEquity = 0;
  var equities = [];
  for (var i = 0; i < holdings.length; i++) {
    var h = holdings[i];
    var price = _holdingsPriceCache[h.ticker] || 0;
    var eq = (h.shares || 0) * price;
    equities.push(eq);
    totalEquity += eq;
  }
  if (totalEquity > 0) {
    for (var i = 0; i < holdings.length; i++) {
      holdings[i].pct = Math.round((equities[i] / totalEquity) * 1000) / 10;
    }
  } else {
    // No price data yet — equal weight
    var eqPct = holdings.length > 0 ? Math.round((100 / holdings.length) * 10) / 10 : 0;
    holdings.forEach(function(h) { h.pct = eqPct; });
  }
}

// Get total portfolio equity
function getTotalEquity() {
  var total = 0;
  for (var i = 0; i < holdings.length; i++) {
    var price = _holdingsPriceCache[holdings[i].ticker] || 0;
    total += (holdings[i].shares || 0) * price;
  }
  return total;
}

function addStock() {
  let ticker = document.getElementById('tickerInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  const sharesInput = document.getElementById('pctInput').value;
  let shares = parseFloat(sharesInput);
  const err = document.getElementById('errorMsg');
  err.textContent = '';
  if (!ticker) { err.textContent = 'Enter a ticker symbol.'; return; }
  // Resolve ticker alias (e.g. RVI → RVTY)
  const dbEntry = STOCK_DB[ticker];
  if (dbEntry && dbEntry.alias) ticker = dbEntry.alias;
  if (holdings.find(h => h.ticker === ticker)) { err.textContent = ticker + ' already added.'; return; }
  // Default to 1 share if not specified
  if (!sharesInput || isNaN(shares) || shares <= 0) shares = 1;
  const info = STOCK_DB[ticker] || {name:ticker, sector:'Other', beta:1.0, cap:'unknown'};
  holdings.push({ticker, shares, pct: 0, ...info});
  document.getElementById('tickerInput').value = '';
  document.getElementById('pctInput').value = '';
  renderHoldings();
  // Recalculate equity-based percentages
  recalcPortfolioPct();
}

function removeStock(ticker) {
  holdings = holdings.filter(h => h.ticker !== ticker);
  renderHoldings();
  if (_holdingsView === 'chart' && holdings.length >= 3) {
    fetchAndRenderSparklines();
  }
  if (typeof renderPortfolioOverview === 'function') renderPortfolioOverview();
}

function editCardShares(ticker, el) {
  var h = holdings.find(function(x) { return x.ticker === ticker; });
  if (!h) return;
  var orig = h.shares || 1;
  var input = document.createElement('input');
  input.type = 'number';
  input.className = 'spark-card-alloc-input';
  input.value = orig;
  input.min = '0.01';
  input.max = '999999';
  input.step = '0.01';
  el.replaceWith(input);
  input.focus();
  input.select();
  function commit() {
    var val = parseFloat(input.value);
    if (!val || val <= 0) val = orig;
    h.shares = Math.round(val * 100) / 100;
    recalcPortfolioPct();
    renderHoldings();
    if (_holdingsView === 'chart' && holdings.length >= 3) fetchAndRenderSparklines();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { h.shares = orig; input.blur(); }
  });
}

function toggleHoldingsGrid() {
  var list = document.getElementById('stockList');
  var chevron = document.getElementById('holdingsGridChevron');
  if (!list) return;
  var collapsed = list.style.display === 'none';
  list.style.display = collapsed ? '' : 'none';
  if (chevron) chevron.style.transform = collapsed ? '' : 'rotate(-90deg)';
}

function setHoldingsView(view) {
  _holdingsView = view;
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  renderHoldings();
  if (view === 'chart' && holdings.length > 0) {
    fetchAndRenderSparklines();
  }
}

function expandUploadZone(trigger) {
  var expanded = document.getElementById('uploadExpanded');
  if (!expanded) return;
  trigger.classList.toggle('expanded');
  expanded.classList.toggle('expanded');
}

function renderHoldings() {
  const list = document.getElementById('stockList');
  const chip = document.getElementById('summaryChip');
  const btn  = document.getElementById('analyzeBtn');
  const total = totalAllocation();

  // Show/hide view toggle for 3+ holdings
  const viewToggle = document.getElementById('holdingsViewToggle');
  if (viewToggle) {
    viewToggle.style.display = holdings.length >= 3 ? 'flex' : 'none';
    if (holdings.length < 3 && _holdingsView !== 'list') _holdingsView = 'list';
  }

  if (_holdingsView === 'chart' && holdings.length >= 3) {
    list.className = 'sparkline-grid';
    list.innerHTML = holdings.map(h => {
      const dbEntry = STOCK_DB[h.ticker] || {};
      const companyName = dbEntry.name || h.ticker;
      const sectorColor = SECTOR_COLORS[h.sector] || SECTOR_COLORS['Other'] || '#475569';
      return `<div class="sparkline-card" onclick="showExpandedChart('${escapeHTML(h.ticker)}')" id="spark-card-${escapeHTML(h.ticker)}">
        <button class="spark-card-remove" onclick="event.stopPropagation();removeStock('${escapeHTML(h.ticker)}')" title="Remove">\u00d7</button>
        <div class="spark-card-header">
          <span class="spark-card-ticker">${escapeHTML(h.ticker)}</span>
          <span class="spark-card-alloc" onclick="event.stopPropagation();editCardShares('${escapeHTML(h.ticker)}',this)">${h.shares || 1} sh</span>
        </div>
        <div class="spark-name">${escapeHTML(companyName)}</div>
        <div class="spark-chart" id="spark-svg-${escapeHTML(h.ticker)}">
          <div class="spark-shimmer"></div>
        </div>
        <div class="spark-card-footer">
          <span class="spark-price" id="spark-price-${escapeHTML(h.ticker)}">--</span>
          <span class="spark-change" id="spark-change-${escapeHTML(h.ticker)}"></span>
        </div>
        <div class="spark-sector-dot" style="background:${sectorColor}"></div>
      </div>`;
    }).join('');
  } else {
    list.className = 'stock-list';
    // Sort by equity (highest first)
    var sorted = holdings.slice().sort(function(a, b) {
      var eqA = (a.shares || 0) * (_holdingsPriceCache[a.ticker] || 0);
      var eqB = (b.shares || 0) * (_holdingsPriceCache[b.ticker] || 0);
      return eqB - eqA;
    });
    list.innerHTML = sorted.map(function(h) {
      var dbEntry = STOCK_DB[h.ticker] || {};
      var companyName = dbEntry.name || '';
      var price = _holdingsPriceCache[h.ticker] || 0;
      var equity = (h.shares || 0) * price;
      var eqStr = price > 0 ? '$' + equity.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : '--';
      var priceStr = price > 0 ? '$' + price.toFixed(2) : '--';
      return '<div class="stock-item">' +
        '<div class="stock-item-top">' +
          '<div class="stock-info">' +
            '<span class="stock-ticker">' + escapeHTML(h.ticker) + '</span>' +
            (companyName ? '<span class="stock-company">' + escapeHTML(companyName) + '</span>' : '') +
          '</div>' +
          '<div class="stock-equity">' + eqStr + '</div>' +
          '<button class="btn-remove" onclick="removeStock(\'' + escapeHTML(h.ticker) + '\')">×</button>' +
        '</div>' +
        '<div class="stock-details-row">' +
          '<span class="stock-shares">' + (h.shares || 0) + ' shares</span>' +
          '<span class="stock-price-sm">' + priceStr + '/share</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  var totalEq = getTotalEquity();
  chip.textContent = totalEq > 0 ? '$' + totalEq.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + ' total' : holdings.length + ' holdings';
  btn.disabled = holdings.length === 0;

  // Hide onboarding when user has holdings OR has saved portfolios
  const ob = document.getElementById('onboardingBanner');
  if (ob) {
    const hasSaved = getSavedPortfolios().length > 0;
    ob.style.display = (holdings.length > 0 || hasSaved) ? 'none' : 'block';
  }

  // Show/hide what-if simulator
  const wiPanel = document.getElementById('whatifPanel');
  if (wiPanel) wiPanel.style.display = holdings.length > 0 ? 'block' : 'none';

  updateRiskScore();
  updateCorrelationWarnings();
  updateWhatIfPanel();

  // Show/hide quick save button
  const quickSave = document.getElementById('btnQuickSave');
  if (quickSave) quickSave.style.display = holdings.length > 0 ? 'inline-block' : 'none';

  // Show/hide clear all button
  const clearBtn = document.getElementById('btnClearAll');
  if (clearBtn) clearBtn.style.display = holdings.length > 0 ? 'inline-block' : 'none';

  // Show/hide new portfolio button (visible when a portfolio is loaded)
  const newBtn = document.getElementById('btnNewPortfolio');
  if (newBtn) newBtn.style.display = (_activePortfolioIdx >= 0 || holdings.length > 0) ? 'inline-block' : 'none';
}

function toggleHoldingsBody() {
  const body = document.getElementById('holdingsBody');
  if (!body) return;
  if (body.classList.contains('collapsed')) {
    expandHoldingsPanel();
  } else {
    collapseHoldingsPanel();
  }
}

function clearAllHoldings() {
  if (holdings.length === 0) return;

  // If a saved portfolio is active, delete it permanently
  if (_activePortfolioIdx >= 0) {
    var portfolios = getSavedPortfolios();
    var name = portfolios[_activePortfolioIdx] ? portfolios[_activePortfolioIdx].name : 'this portfolio';
    if (!confirm('Delete "' + name + '" permanently?')) return;
    portfolios.splice(_activePortfolioIdx, 1);
    localStorage.setItem('pc_portfolios', JSON.stringify(portfolios));
  } else {
    if (!confirm('Clear all holdings?')) return;
  }

  holdings.length = 0;
  _activePortfolioIdx = -1;
  _activePortfolioSnapshot = null;
  if (typeof hidePortfolioOverview === 'function') hidePortfolioOverview();
  document.getElementById('resultsPanel').innerHTML = '<div class="empty-state"><div class="empty-compass"><div class="empty-compass-ring"></div><div class="empty-compass-needle"></div><div class="empty-compass-center"></div></div><div class="empty-state-title">Ready to analyze</div><div class="empty-state-hint">Add your US stock holdings on the left, then click<br><strong>Analyze</strong></div></div>';
  renderHoldings();
  expandInputSections();
  if (typeof expandHoldingsPanel === 'function') expandHoldingsPanel();
  closeSidebar();
  // Re-render the portfolio strip to remove the deleted portfolio
  if (typeof renderPortfolioStrip === 'function') renderPortfolioStrip(null);
  // Re-enable sticky button visibility for next portfolio
  const stickyBtn = document.querySelector('.btn-analyze-sticky');
  if (stickyBtn) stickyBtn.dataset.analyzed = '';
}

function newPortfolio() {
  // Deactivate current portfolio and start fresh
  _activePortfolioIdx = -1;
  _activePortfolioSnapshot = null;
  holdings.length = 0;
  if (typeof hidePortfolioOverview === 'function') hidePortfolioOverview();
  document.getElementById('resultsPanel').innerHTML = '<div class="empty-state"><div class="empty-compass"><div class="empty-compass-ring"></div><div class="empty-compass-needle"></div><div class="empty-compass-center"></div></div><div class="empty-state-title">Ready to analyze</div><div class="empty-state-hint">Add your US stock holdings on the left, then click<br><strong>Analyze</strong></div></div>';
  renderHoldings();
  expandInputSections();
  if (typeof expandHoldingsPanel === 'function') expandHoldingsPanel();
  if (typeof renderPortfolioStrip === 'function') renderPortfolioStrip(null);
}

function updateSlider(i, val) {
  const newPct = parseFloat(val);
  const oldPct = holdings[i].pct;
  const otherTotal = totalAllocation() - oldPct;
  if (otherTotal + newPct > 100.05) return;
  holdings[i].pct = Math.round(newPct * 10) / 10;
  document.getElementById('slider-pct-' + i).textContent = holdings[i].pct + '%';
  const total = totalAllocation();
  const chip = document.getElementById('summaryChip');
  if (chip) chip.textContent = total + '% allocated';
  // Update all slider max values so they can't exceed 100% total
  holdings.forEach((h, j) => {
    const sl = document.getElementById('slider-' + j);
    if (sl) sl.max = Math.min(100, h.pct + (100 - total));
  });
  updateRiskScore();
  updateCorrelationWarnings();
}

function getPortfolioProfile() {
  const sectors = {};
  let beta = 0;
  holdings.forEach(h => {
    sectors[h.sector] = (sectors[h.sector] || 0) + h.pct;
    beta += (h.beta || 1.0) * h.pct;
  });
  const total = totalAllocation() || 1;
  Object.keys(sectors).forEach(s => { sectors[s] = Math.round((sectors[s]/total)*100); });
  return {sectors, beta: Math.round((beta/total)*100)/100};
}

// ── STRATEGY LEGEND HOVER ────────────────────────────────
let pinnedStrategy = null;

function showStrategy(s) {
  if (pinnedStrategy) return;
  const el = document.getElementById('sectorBarsEl');
  if (el) el.classList.add('show-' + s);
  document.querySelectorAll('.legend-item.hoverable').forEach(e => e.classList.remove('active'));
  document.querySelector('[data-strategy="' + s + '"]')?.classList.add('active');
}

function hideStrategy(s) {
  if (pinnedStrategy) return;
  const el = document.getElementById('sectorBarsEl');
  if (el) el.classList.remove('show-' + s);
  document.querySelector('[data-strategy="' + s + '"]')?.classList.remove('active');
}

function toggleStrategy(s) {
  const el = document.getElementById('sectorBarsEl');
  if (!el) return;
  if (pinnedStrategy === s) {
    pinnedStrategy = null;
    el.classList.remove('show-agg','show-mod','show-con');
    document.querySelectorAll('.legend-item.hoverable').forEach(e => e.classList.remove('active','active-agg','active-mod','active-con'));
  } else {
    pinnedStrategy = s;
    el.classList.remove('show-agg','show-mod','show-con');
    el.classList.add('show-' + s);
    document.querySelectorAll('.legend-item.hoverable').forEach(e => e.classList.remove('active','active-agg','active-mod','active-con'));
    const item = document.querySelector('[data-strategy="' + s + '"]');
    if (item) item.classList.add('active','active-' + s);
  }
}

// ── POSITION SIZING HELPERS ──────────────────────────────


// ── ANALYZE ──────────────────────────────────────────────
var SECTOR_GROUPS = {
  tech: ['Big Tech','Semiconductors','AI & Robotics','Software / SaaS','Social Media','Fintech','Crypto / Bitcoin','Cybersecurity'],
  healthcare: ['Healthcare','Biotech','Pharma'],
  consumer: ['E-Commerce','Retail','Apparel','Food & Beverage','Consumer Staples','Pets & Specialty'],
  energy: ['Oil & Gas','Clean Energy','Utilities'],
  financial: ['Banking','Fintech','Insurance'],
  industrial: ['Defense','Industrials','Aerospace','Materials','Real Estate'],
};

function _getSectorGroup(sectorName) {
  for (var g in SECTOR_GROUPS) {
    if (SECTOR_GROUPS[g].indexOf(sectorName) >= 0) return g;
  }
  return null;
}

function _computeGroupExposure(profileSectors) {
  var exposure = {};
  for (var g in SECTOR_GROUPS) {
    var total = 0;
    SECTOR_GROUPS[g].forEach(function(s) { total += (profileSectors[s] || 0); });
    exposure[g] = total;
  }
  return exposure;
}

function scoreETF(etf, profile, missingSectorNames) {
  let score = 70;
  if (etf.sectors.includes('all')) {
    // Broad market ETFs get a moderate boost — they fill gaps broadly
    score += missingSectorNames.length > 3 ? 8 : 3;
  } else {
    // HARD RULE: If ANY of the ETF's sectors is already >15% of the portfolio,
    // this ETF would ADD to an overweight position — exclude it entirely
    var hasOverweight = etf.sectors.some(s => (profile.sectors[s] || 0) > 15);
    if (hasOverweight) return 0;

    etf.sectors.forEach(s => {
      var current = profile.sectors[s] || 0;
      var isMissing = missingSectorNames.indexOf(s) >= 0;
      var target = SECTOR_TARGETS[s] || {agg:0,mod:0,con:0};
      var maxTarget = Math.max(target.agg, target.mod, target.con);
      if (current === 0 && isMissing && maxTarget >= 5) score += 22;
      else if (current === 0 && isMissing) score += 14;
      else if (current === 0) score += 6;
      else if (current < 10 && isMissing) score += 10;
      else if (current > 10) score -= 15;
    });

    // Group exposure penalty: if ALL of the ETF's sectors are in groups
    // that already have >25% portfolio exposure, penalize heavily
    var groupExposure = _computeGroupExposure(profile.sectors);
    var allInOverexposed = etf.sectors.length > 0 && etf.sectors.every(function(s) {
      var g = _getSectorGroup(s);
      return g && groupExposure[g] > 25;
    });
    if (allInOverexposed) score -= 30;

    // Correlation penalty: if ETF appears in CORRELATED_PAIRS where
    // portfolio holds 2+ stocks from the correlated group
    if (typeof CORRELATED_PAIRS !== 'undefined') {
      var ownedTickers = holdings.map(function(h) { return h.ticker; });
      CORRELATED_PAIRS.forEach(function(pair) {
        var stocks = pair[0], etfs = pair[1];
        if (etfs.indexOf(etf.ticker) >= 0) {
          var overlap = stocks.filter(function(t) { return ownedTickers.indexOf(t) >= 0; });
          if (overlap.length >= 2) score -= 20;
        }
      });
    }
  }
  return Math.min(99, Math.max(0, score));
}

function getTopETFs(category, profile, n, missingSectorNames) {
  const owned = holdings.map(h => h.ticker);
  return ETF_DB[category]
    .filter(e => !owned.includes(e.ticker))
    .map(e => ({...e, score:scoreETF(e, profile, missingSectorNames)}))
    .filter(e => e.score >= 40)
    .sort((a,b) => b.score - a.score)
    .slice(0, n);
}

function matchLabel(score) {
  if (score >= 85) return '<span class="match-score match-high">✦ Best match to balance your portfolio</span>';
  return '<span class="match-score match-med">◈ Good match to balance your portfolio</span>';
}

function analyze() {
  pinnedStrategy = null;
  document.querySelectorAll('.legend-item.hoverable').forEach(e => e.classList.remove('active','active-agg','active-mod','active-con'));
  const profile = getPortfolioProfile();
  const {sectors} = profile;

  // Compute missing sectors first so recommendations can use them
  const heldSectors = Object.entries(sectors).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]);
  const missingSectors = Object.entries(SECTOR_TARGETS)
    .filter(([name, t]) => !(sectors[name] > 0) && (t.agg >= 3 || t.mod >= 3 || t.con >= 3))
    .sort((a,b) => Math.max(b[1].agg,b[1].mod,b[1].con) - Math.max(a[1].agg,a[1].mod,a[1].con))
    .slice(0, 8);
  const missingSectorNames = missingSectors.map(function(e) { return e[0]; });

  const aggressiveETFs = getTopETFs('aggressive', profile, 3, missingSectorNames);
  const moderateETFs   = getTopETFs('moderate',   profile, 3, missingSectorNames);
  const conservativeETFs = getTopETFs('conservative', profile, 3, missingSectorNames);

  // Sector bars

  const maxVal = Math.max(...heldSectors.map(([,v]) => v), 1);
  const capVal = Math.min(maxVal, 35); // cap so bars look fuller even with small %
  const scale = v => Math.min(100, Math.round((v/capVal)*100));

  const makeBar = (name, cur, isMissing) => {
    const t = SECTOR_TARGETS[name] || {agg:0,mod:0,con:0};
    const color = SECTOR_COLORS[name] || '#64748b';
    const icon  = SECTOR_ICONS[name]  || '◆';
    return '<div class="sector-row' + (isMissing?' missing':'') + '">' +
      '<span class="sector-name">' + icon + ' ' + name + '</span>' +
      '<div class="sector-bar-track' + (isMissing?' empty':'') + '">' +
      (!isMissing ? '<div class="sector-bar-fill" style="width:' + scale(cur) + '%;background:' + color + '"></div>' : '') +
      '<div class="sector-tick agg" style="left:' + scale(t.agg) + '%"></div>' +
      '<div class="sector-tick mod" style="left:' + scale(t.mod) + '%"></div>' +
      '<div class="sector-tick con" style="left:' + scale(t.con) + '%"></div>' +
      '</div>' +
      '<span class="sector-pct">' + (isMissing ? '—' : cur + '%') + '</span>' +
      '</div>';
  };

  const sectorBars = heldSectors.map(([n,v]) => makeBar(n,v,false)).join('') +
    (missingSectors.length > 0 ? '<div class="sector-divider"><span>Not in your portfolio</span></div>' + missingSectors.map(([n]) => makeBar(n,0,true)).join('') : '');

  // Stock picks per strategy
  const ownedTickers = holdings.map(h => h.ticker);
  const ownedSectors = Object.keys(sectors).filter(s => (sectors[s]||0) > 5);
  const safeStr = s => s.replace(/'/g,"\\'").replace(/"/g,'&quot;');

  function getScoredPicks(strategyKey, marketData) {
    const riskAllowed = {
      aggressive:['High','Very High','Medium'],
      moderate:['Medium','Low','High'],
      conservative:['Low','Medium'],
    }[strategyKey] || ['Medium'];
    var groupExposure = _computeGroupExposure(sectors);
    // Map strategy to target key for sector-gap scoring
    var strategyTargetKey = {aggressive:'agg',moderate:'mod',conservative:'con'}[strategyKey];
    return STOCK_PICKS
      .filter(p => {
        if (ownedTickers.includes(p.ticker)) return false;
        if (p.avoidIfHeld.some(t => ownedTickers.includes(t))) return false;
        if (!riskAllowed.includes(p.risk)) return false;
        // Exclude stocks in sectors the user already has >15% — would worsen concentration
        var currentAlloc = sectors[p.sector] || 0;
        if (currentAlloc > 15) return false;
        return true;
      })
      .map(p => {
        let score = 50;
        var isMissing = missingSectorNames.indexOf(p.sector) >= 0;
        var target = SECTOR_TARGETS[p.sector] || {agg:0,mod:0,con:0};
        var maxTarget = Math.max(target.agg, target.mod, target.con);
        var stratTarget = target[strategyTargetKey] || 0;
        var currentAlloc = sectors[p.sector] || 0;
        // Boost stocks that fill gaps in portfolio (balance-first)
        if (!ownedSectors.includes(p.sector) && isMissing && maxTarget >= 5) score += 30;
        else if (!ownedSectors.includes(p.sector) && isMissing) score += 20;
        else if (!ownedSectors.includes(p.sector)) score += 10;
        else if (currentAlloc < 10 && isMissing) score += 14;
        // Bonus for filling underweight sectors relative to strategy target
        if (stratTarget > 0 && currentAlloc < stratTarget) {
          score += Math.round((stratTarget - currentAlloc) * 0.8);
        }
        if (p.risk === 'Low') score += 6;
        if (p.risk === 'Very High') score -= 8;
        // Group exposure penalty
        var g = _getSectorGroup(p.sector);
        if (g && groupExposure[g] > 25) score -= 20;
        // Correlation penalty
        if (typeof CORRELATED_PAIRS !== 'undefined') {
          CORRELATED_PAIRS.forEach(function(pair) {
            var stocks = pair[0], etfs = pair[1];
            if (etfs.indexOf(p.ticker) >= 0) {
              var overlap = stocks.filter(function(t) { return ownedTickers.indexOf(t) >= 0; });
              if (overlap.length >= 2) score -= 15;
            }
          });
        }
        // Boost/penalise with live momentum (±15 pts max)
        const md = marketData && marketData[p.ticker];
        if (md) score += Math.round((md.momentum - 50) * 0.3);
        return {...p, score, isStock:true};
      })
      .filter(p => p.score >= 40) // Only show stocks that genuinely help balance the portfolio
      .sort((a,b) => b.score - a.score)
      .slice(0,8);
  }

  // ── Market data badge HTML helper ────────────────────────
  // Returns compact inline badge: "$123.45 ▲ +1.23%"
  function marketBadgeHTML(ticker, marketData) {
    if (!marketData) return '';
    const md = marketData[ticker];
    if (!md || md.price == null || md.changePct == null) return '';
    const dir   = md.changePct > 0.05 ? 'up' : md.changePct < -0.05 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—';
    const sign  = md.changePct > 0 ? '+' : '';
    const { isOpen } = getMarketStatus();
    const closeLabel = !isOpen ? '<span class="market-close-label">at close</span>' : '';
    return '<span class="market-inline">' +
      '<span class="market-inline-price"><span class="currency">$</span>' + md.price.toFixed(2) + '</span>' +
      '<span class="market-badge ' + dir + '">' + arrow + ' ' + sign + md.changePct.toFixed(2) + '%</span>' +
      closeLabel +
      '</span>';
  }

  function buildItemHTML(item, type, marketData) {
    const eTicker = escapeHTML(item.ticker);
    const eName = escapeHTML(item.name);
    const eDesc = escapeHTML(item.desc);
    const id = 'item-' + eTicker + '-' + type;
    const sectorColor = item.isStock ? (SECTOR_COLORS[item.sector] || '#64748b') : (SECTOR_COLORS[item.sectors?.[0]] || '#4d9fff');
    if (!item.isStock) {
      var holdingsData = (typeof ETF_TOP_HOLDINGS !== 'undefined' && ETF_TOP_HOLDINGS[item.ticker]) || [];
      var holdingsHTML = '';
      if (holdingsData.length > 0) {
        holdingsHTML = '<div class="etf-holdings"><span class="etf-holdings-label">Top Holdings</span>' +
          holdingsData.slice(0, 6).map(function(h) {
            return '<span class="etf-holding-chip">' + escapeHTML(h[0]) + '<span class="etf-holding-pct">' + h[2] + '%</span></span>';
          }).join('') + '</div>';
      }
      return '<div class="etf-item etf-type-etf" style="--sector-color:' + sectorColor + '" id="' + id + '" onclick="toggleDrawer(\'' + eTicker + '\',\'' + type + '\',\'' + safeStr(item.name) + '\',\'' + safeStr(item.desc) + '\',false)">' +
        '<div class="etf-item-header"><div class="ticker-name-group"><div class="ticker-with-tag">' +
        '<span class="etf-ticker">' + eTicker + '</span><span class="item-type-tag tag-etf">ETF</span></div>' +
        '<div class="etf-details"><h4>' + eName + ' ' + marketBadgeHTML(item.ticker, marketData) + '</h4><p>' + eDesc + '</p></div></div>' +
        '<div class="etf-meta"><div class="pick-sector-tag">' + escapeHTML(item.sectors[0] === 'all' ? 'Broad Market' : item.sectors[0]) + '</div>' + matchLabel(item.score) + '</div></div>' +
        holdingsHTML +
        '<div class="pick-hint">✦ Why this for my portfolio?</div>' +
        '<div class="etf-drawer" id="drawer-' + id + '"><div class="etf-drawer-inner">' +
        '<div class="etf-drawer-label">◈ Why this pick?</div>' +
        '<div class="etf-drawer-text" id="drawer-text-' + id + '"></div></div></div></div>';
    } else {
      return '<div class="etf-item etf-type-stock" style="--sector-color:' + sectorColor + '" id="' + id + '" onclick="toggleDrawer(\'' + eTicker + '\',\'' + type + '\',\'' + safeStr(item.name) + '\',\'' + safeStr(item.desc) + '\',true)">' +
        '<div class="etf-item-header"><div class="ticker-name-group"><div class="ticker-with-tag">' +
        '<span class="pick-ticker">' + eTicker + '</span><span class="item-type-tag tag-stock">STOCK</span></div>' +
        '<div class="pick-details"><h4>' + eName + ' ' + marketBadgeHTML(item.ticker, marketData) + '</h4><p>' + eDesc + '</p></div></div>' +
        '<div class="pick-meta"><div class="pick-sector-tag">' + escapeHTML(item.sector) + '</div>' +
        '<div class="pick-risk" style="color:' + (RISK_COLORS[item.risk]||'#888') + '">' + escapeHTML(item.risk) + ' Risk</div></div></div>' +
        '<div class="pick-hint">✦ Why this for my portfolio?</div>' +
        '<div class="pick-drawer" id="drawer-' + id + '"><div class="pick-drawer-inner">' +
        '<div class="pick-drawer-label">◈ Why this pick?</div>' +
        '<div class="pick-drawer-text" id="drawer-text-' + id + '"></div></div></div></div>';
    }
  }

  function strategyCard(type, label, desc, etfs, marketData) {
    const picks = getScoredPicks(type, marketData);
    const taggedEtfs = etfs.map(e => {
      const md = marketData && marketData[e.ticker];
      const liveScore = e.score + (md ? Math.round((md.momentum - 50) * 0.3) : 0);
      return {...e, score: liveScore, isStock: false};
    });

    // All items combined and sorted by score — best portfolio-balancing picks first
    const allItems = [...taggedEtfs, ...picks].sort((a,b) => b.score - a.score);

    // Primary: first 5 (from truncated free data)
    const primaryItems = allItems.slice(0,5);
    const primaryHTML = primaryItems.map(item => buildItemHTML(item, type, marketData)).join('');

    // Expose buildItemHTML and marketData for dynamic pro pick rendering
    _lastBuildItemHTML = buildItemHTML;
    _lastMarketData = marketData;

    // Show-more container — available to all users (static data, no API cost)
    const extraHTML =
      '<div class="show-more-items" id="show-more-' + type + '"></div>' +
      '<button class="btn-show-more" id="show-more-btn-' + type + '" onclick="toggleShowMore(\'' + type + '\')" data-shown="0">' +
        '✦ See more stocks' +
      '</button>';

    return '<div class="strategy-card"><div class="strategy-header strategy-toggle" onclick="toggleStrategyCard(this)">' +
      '<div class="strategy-label">' +
      '<span class="strategy-badge badge-' + type + '">' + label + '</span>' +
      '<span class="strategy-best-match-slot"></span>' +
      '<span class="strategy-chevron">&#9662;</span><span class="strategy-expand-hint">tap to expand</span></div>' +
      '<span class="strategy-desc">' + desc + '</span></div>' +
      '<div class="etf-list strategy-collapsed">' + primaryHTML + extraHTML + '</div></div>';
  }

  function renderResultsPanel(marketData) {
    const refreshTime = marketData ? new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : null;
    const sampleState = marketData && Object.values(marketData)[0]?.marketState;
    const isLiveNow   = sampleState === 'REGULAR';
    const stateLabel  = sampleState === 'PRE'  ? 'Pre-Market' :
                        sampleState === 'POST' ? 'After Hours' :
                        sampleState === 'REGULAR' ? 'Live' : 'At Close';
    const statusHTML = marketData
      ? '<span class="market-status ' + (isLiveNow ? 'live' : '') + '">&#9679; ' + stateLabel + ' &mdash; updated ' + refreshTime + '</span>'
      : '<span class="market-status error">&#9888; Market data unavailable</span>';

    // ── Portfolio Health Panel ──
    const sectorEntries = Object.entries(profile.sectors).filter(([,v]) => v > 0).sort((a,b) => b[1] - a[1]);
    const topSectorPct = sectorEntries.length > 0 ? sectorEntries[0][1] : 0;
    const topSectorName = sectorEntries.length > 0 ? sectorEntries[0][0] : '—';
    const numSectors = sectorEntries.length;
    const largestHolding = holdings.reduce((a,b) => a.pct > b.pct ? a : b, holdings[0]);

    // Risk level label
    const riskLabel = profile.beta >= 1.3 ? 'Aggressive' : profile.beta >= 0.85 ? 'Moderate' : 'Conservative';
    const riskClass = riskLabel.toLowerCase();
    const riskDesc = riskLabel === 'Aggressive' ? 'High growth, high risk' : riskLabel === 'Moderate' ? 'Growth with stability' : 'Low risk, steady returns';
    const riskBarColor = riskLabel === 'Aggressive' ? 'var(--aggressive)' : riskLabel === 'Moderate' ? 'var(--moderate)' : 'var(--conservative)';
    const riskBarPct = Math.min(100, Math.round(profile.beta * 60));

    // Diversification score (0–100)
    const divScore = Math.min(100, Math.round(
      (numSectors >= 8 ? 30 : numSectors * 3.5) +
      (topSectorPct <= 20 ? 30 : topSectorPct <= 30 ? 20 : topSectorPct <= 40 ? 10 : 0) +
      (holdings.length >= 10 ? 20 : holdings.length * 2) +
      (largestHolding && largestHolding.pct <= 10 ? 20 : largestHolding && largestHolding.pct <= 15 ? 15 : largestHolding && largestHolding.pct <= 20 ? 10 : 5)
    ));
    const divLabel = divScore >= 75 ? 'Well diversified' : divScore >= 50 ? 'Moderate' : 'Concentrated';
    const divClass = divScore >= 75 ? 'conservative' : divScore >= 50 ? 'moderate' : 'aggressive';

    // Alert
    const alertHTML = topSectorPct >= 30
      ? '<div class="health-alert">&#9888; ' + topSectorName + ' makes up ' + Math.round(topSectorPct) + '% of your portfolio — watch for sector-specific volatility.</div>'
      : '';

    // VS S&P 500 comparisons
    const spyBeta = 1.0;
    const spyTopSector = 28;
    const spyTopHolding = 7;
    const betaDiff = (profile.beta - spyBeta).toFixed(2);
    const sectorDiff = Math.round(topSectorPct - spyTopSector);
    const holdDiff = Math.round((largestHolding ? largestHolding.pct : 0) - spyTopHolding);
    const diffBadge = (val, suffix, invert) => {
      const num = typeof val === 'string' ? parseFloat(val) : val;
      const abs = Math.abs(num);
      const cls = (invert ? num <= 0 : num >= 0) ? (abs > 8 ? 'bad' : 'warn') : 'good';
      return '<span class="health-compare-diff ' + cls + '">' + (num > 0 ? '+' : '') + val + suffix + '</span>';
    };

    const healthHTML =
      '<div class="health-panel">' +
        '<div class="panel-header panel-toggle" onclick="togglePanel(this)"><h2 class="section-title">Portfolio Health</h2><span class="panel-chevron panel-chevron-open">&#9662;</span><span class="panel-expand-hint">tap to collapse</span></div>' +
        '<div class="panel-body">' +
        alertHTML +
        '<div class="health-cards">' +
          '<div class="health-card">' +
            '<div class="health-card-label">Risk Level</div>' +
            '<div class="health-card-value ' + riskClass + '">' + riskLabel + '</div>' +
            '<div class="health-card-sub">' + riskDesc + '</div>' +
            '<div class="health-card-sub" style="opacity:0.5;margin-top:2px">Beta ' + profile.beta.toFixed(2) + '</div>' +
            '<div class="health-card-bar"><div class="health-card-bar-fill" style="width:' + riskBarPct + '%;background:' + riskBarColor + '"></div></div>' +
          '</div>' +
          '<div class="health-card">' +
            '<div class="health-card-label">Diversification</div>' +
            '<div class="health-card-value ' + divClass + '">' + divScore + '<span style="font-size:14px;color:var(--muted)">/100</span></div>' +
            '<div class="health-card-sub">' + divLabel + '</div>' +
            '<div class="health-card-sub" style="margin-top:2px">' + numSectors + ' sectors &middot; top: ' + Math.round(topSectorPct) + '%</div>' +
          '</div>' +
        '</div>' +
        '<div class="health-compare">' +
          '<div class="health-compare-title">vs S&amp;P 500 (SPY)</div>' +
          '<div class="health-compare-row">' +
            '<span class="health-compare-label">Portfolio Beta</span>' +
            '<span class="health-compare-val">' + profile.beta.toFixed(2) + '</span>' +
            '<span class="health-compare-spy">SPY 1.0</span>' +
            diffBadge(betaDiff, '', true) +
          '</div>' +
          '<div class="health-compare-row">' +
            '<span class="health-compare-label">Top Sector</span>' +
            '<span class="health-compare-val">' + Math.round(topSectorPct) + '%</span>' +
            '<span class="health-compare-spy">SPY ~28%</span>' +
            diffBadge(sectorDiff, '%', true) +
          '</div>' +
          '<div class="health-compare-row">' +
            '<span class="health-compare-label">Largest Holding</span>' +
            '<span class="health-compare-val">' + (largestHolding ? largestHolding.ticker + ' ' + Math.round(largestHolding.pct) + '%' : '—') + '</span>' +
            '<span class="health-compare-spy">SPY top ~7%</span>' +
            diffBadge(holdDiff, '%', true) +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>';

    // ── Rebalancing Suggestions ──
    const missingSectorsSugg = Object.entries(SECTOR_TARGETS)
      .filter(([name, t]) => !(profile.sectors[name] > 0) && (t.mod >= 5 || t.agg >= 5))
      .sort((a,b) => Math.max(b[1].agg,b[1].mod,b[1].con) - Math.max(a[1].agg,a[1].mod,a[1].con))
      .slice(0, 4);
    let rebalanceHTML = '';
    if (missingSectorsSugg.length > 0) {
      const items = missingSectorsSugg.map(([name, t]) => {
        const target = Math.max(t.agg, t.mod, t.con);
        return '<div class="rebalance-item">' +
          '<span style="color:var(--accent)">&#9656;</span> ' +
          '<span><span class="sector-link">' + name + '</span> ' +
          '<span class="rebalance-note">— not in your portfolio, moderate target ~' + t.mod + '%</span></span>' +
          '</div>';
      }).join('');
      rebalanceHTML =
        '<div class="rebalance-panel">' +
          '<div class="panel-header panel-toggle" onclick="togglePanel(this)"><h2 class="section-title">Rebalancing Suggestions</h2><span class="panel-chevron panel-chevron-open">&#9662;</span><span class="panel-expand-hint">tap to collapse</span></div>' +
          '<div class="panel-body"><div class="rebalance-list">' + items + '</div></div>' +
        '</div>';
    }

    document.getElementById('resultsPanel').innerHTML =
      healthHTML +
      '<div class="share-export-row">' +
        '<button class="btn-share" onclick="sharePortfolio()">🔗 Share Portfolio</button>' +
      '</div>' +
      '<div class="analysis-bar">' +
        '<div class="analysis-bar-header panel-toggle" onclick="togglePanel(this)">' +
          '<h2 class="section-title">Portfolio Breakdown</h2>' +
          '<span class="panel-expand-hint">tap to collapse</span><span class="panel-chevron panel-chevron-open">&#9662;</span>' +
        '</div>' +
        '<div class="panel-body">' +
        '<div class="breakdown-legend">' +
            '<div class="legend-item"><div class="legend-dot legend-dot-current"></div>You Own</div>' +
            '<div class="legend-hint">tap to show</div>' +
            '<div class="legend-item hoverable" data-strategy="agg">' +
              '<div class="legend-tick legend-tick-agg"></div>Aggressive' +
              '<div class="strategy-tooltip"><div class="tooltip-label agg">&#9889; Aggressive</div>' +
              '<div class="tooltip-body">High-growth sectors with above-average volatility. Heavy tech, AI, semis, and emerging markets. Expects significant drawdowns but maximum long-term upside.</div>' +
              '<div class="tooltip-note">Best for: 10+ year horizon, high risk tolerance, can stomach 40%+ drops without panic selling.</div></div>' +
            '</div>' +
            '<div class="legend-item hoverable" data-strategy="mod">' +
              '<div class="legend-tick legend-tick-mod"></div>Moderate' +
              '<div class="strategy-tooltip"><div class="tooltip-label mod">&#9670; Moderate</div>' +
              '<div class="tooltip-body">Mix of growth and defensive sectors. Spreads risk across tech, financials, healthcare, and staples. Aims for steady compounding with manageable volatility.</div>' +
              '<div class="tooltip-note">Best for: 5-10 year horizon, moderate risk tolerance. The S&P 500 is basically this, proven over decades.</div></div>' +
            '</div>' +
            '<div class="legend-item hoverable" data-strategy="con">' +
              '<div class="legend-tick legend-tick-con"></div>Conservative' +
              '<div class="strategy-tooltip"><div class="tooltip-label con">&#9632; Conservative</div>' +
              '<div class="tooltip-body">Defensive, income-focused sectors: bonds, utilities, healthcare, dividends, real estate. Prioritizes capital preservation over growth. Lower highs, but also lower lows.</div>' +
              '<div class="tooltip-note">Best for: near retirement, income needs, or simply sleeping well at night. Boring is underrated.</div></div>' +
            '</div>' +
          '</div>' +
        '<div class="sector-bars" id="sectorBarsEl">' + sectorBars + '</div>' +
        '</div>' +
      '</div>' +
      rebalanceHTML +
      '<div class="rebalance-panel recommended-panel">' +
        '<div class="panel-header panel-toggle" onclick="togglePanel(this)">' +
          '<h2 class="section-title">Recommended Stocks</h2>' + statusHTML +
          '<span class="panel-chevron panel-chevron-open">&#9662;</span>' +
        '</div>' +
        '<div class="panel-body recommended-body">' +
          (function() {
            var cards = [
              {key:'aggressive', label:'Aggressive', desc:'High growth, high risk', etfs:aggressiveETFs},
              {key:'moderate',   label:'Moderate',   desc:'Growth with stability',  etfs:moderateETFs},
              {key:'conservative',label:'Conservative',desc:'Capital preservation', etfs:conservativeETFs}
            ];
            var bestMatch = profile.beta >= 1.3 ? 'aggressive' : profile.beta >= 0.85 ? 'moderate' : 'conservative';
            cards.sort(function(a,b) { return (a.key === bestMatch ? -1 : b.key === bestMatch ? 1 : 0); });
            return cards.map(function(c) { return strategyCard(c.key, c.label, c.desc, c.etfs, marketData); }).join('');
          })() +
        '</div>' +
      '</div>' +
      '<div class="disclaimer-footer">&#9432; For informational purposes only. Not financial advice. Past performance does not guarantee future results. Always consult a qualified financial advisor before making investment decisions.<br><span style="opacity:0.6">Prices from FMP &middot; Ranked by portfolio fit + live momentum.</span></div>';

    // Re-attach strategy legend listeners
    document.querySelectorAll('.legend-item.hoverable').forEach(el => {
      const s = el.dataset.strategy;
      if (!s) return;
      el.addEventListener('mouseenter', () => showStrategy(s));
      el.addEventListener('mouseleave', () => hideStrategy(s));
      el.addEventListener('click',      () => toggleStrategy(s));
    });

    // Add "Best match" badge and auto-expand the matching card
    (function() {
      var matchType = profile.beta >= 1.3 ? 'aggressive' : profile.beta >= 0.85 ? 'moderate' : 'conservative';
      var cards = document.querySelectorAll('.strategy-card');
      cards.forEach(function(card) {
        var badge = card.querySelector('.strategy-badge');
        var slot = card.querySelector('.strategy-best-match-slot');
        if (badge && slot && badge.classList.contains('badge-' + matchType)) {
          slot.innerHTML = '<span class="strategy-best-match">Best match for you</span>';
          // Auto-expand best-match strategy card
          var list = card.querySelector('.etf-list');
          if (list) list.classList.remove('strategy-collapsed');
        }
      });
    })();
  }

  // Collect only the tickers actually rendered (max ~15)
  const renderedTickers = [];
  [aggressiveETFs, moderateETFs, conservativeETFs].forEach(etfs => {
    etfs.slice(0,3).forEach(e => renderedTickers.push(e.ticker));
  });
  [getScoredPicks('aggressive',null), getScoredPicks('moderate',null), getScoredPicks('conservative',null)]
    .forEach(picks => picks.forEach(p => renderedTickers.push(p.ticker)));
  const tickersToFetch = [...new Set(renderedTickers)];

  // Render immediately with loading placeholders
  renderResultsPanel(null);

  // Show portfolio overview chart + square holdings cards
  if (holdings.length >= 3) {
    _holdingsView = 'chart';
    document.querySelectorAll('.view-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.view === 'chart');
    });
    renderHoldings();
    fetchAndRenderSparklines();
    if (typeof renderPortfolioOverview === 'function') renderPortfolioOverview();
  }

  // Scroll so Portfolio Health is visible with Analyze button just above fold
  setTimeout(function() {
    var healthEl = document.querySelector('.health-panel');
    if (healthEl) {
      var rect = healthEl.getBoundingClientRect();
      var offset = rect.top + window.pageYOffset - 60;
      window.scrollTo({ top: offset, behavior: 'smooth' });
    }
  }, 100);

  // Hide sticky analyze button after results show
  setTimeout(() => {
    const stickyBtn = document.querySelector('.btn-analyze-sticky');
    if (stickyBtn) stickyBtn.classList.remove('visible');
  }, 150);

  // Fetch market data — checks localStorage cache first (1hr TTL) before hitting API
  (async function fetchMarketDataCachedCall() {
    const marketData = await fetchMarketDataCached(tickersToFetch);
    lastMarketFetch = Date.now();
    renderResultsPanel(marketData);
    updateRefreshBtn();
  })();

  // Start live refresh if market is open
  if (typeof _startLiveRefresh === 'function' && typeof getMarketStatus === 'function' && getMarketStatus().isOpen) {
    _startLiveRefresh();
  }
}

// ── LIVE BADGE PATCHER ───────────────────────────────────
// Updates a single ticker's badge across all strategy cards without full re-render
function patchMarketBadge(ticker, md) {
  if (!md || md.price == null || md.changePct == null) return;
  const dir   = md.changePct > 0.05 ? 'up' : md.changePct < -0.05 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—';
  const sign  = md.changePct > 0 ? '+' : '';
  const html  =
    '<span class="market-inline">' +
    '<span class="market-inline-price">$' + md.price.toFixed(2) + '</span>' +
    '<span class="market-badge ' + dir + '">' + arrow + ' ' + sign + md.changePct.toFixed(2) + '%</span>' +
    '</span>';

  // Each ticker can appear in multiple strategy cards — patch all of them
  document.querySelectorAll('.etf-item').forEach(el => {
    const tickerEl = el.querySelector('.etf-ticker, .pick-ticker');
    if (tickerEl && tickerEl.textContent.trim() === ticker) {
      const nameEl = el.querySelector('.etf-details h4, .pick-details h4');
      if (nameEl) {
        // Remove any existing market-inline span
        const existing = nameEl.querySelector('.market-inline, .market-badge');
        if (existing) existing.remove();
        nameEl.insertAdjacentHTML('beforeend', html);
      }
    }
  });
}

// ── MARKET HOURS DETECTION ───────────────────────────────
function getMarketStatus() {
  // NYSE hours: Mon–Fri 9:30am–4:00pm ET
  const now = new Date();
  const etOffset = -5; // EST (UTC-5); EDT is UTC-4
  // Detect DST: second Sunday of March to first Sunday of November
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const isDST = now.getTimezoneOffset() < stdOffset;
  const etHour = now.getUTCHours() + (isDST ? -4 : -5);
  const etMin  = now.getUTCMinutes();
  const etTime = etHour + etMin / 60; // decimal hours in ET
  const day    = now.getUTCDay();     // 0=Sun, 6=Sat

  // Adjust day for ET offset crossing midnight
  const utcMidnightET = isDST ? 4 : 5;
  const etDay = now.getUTCHours() < utcMidnightET
    ? (day === 0 ? 6 : day - 1)
    : day;

  const isWeekday  = etDay >= 1 && etDay <= 5;
  const isOpen     = isWeekday && etTime >= 9.5 && etTime < 16;
  const isPrePost  = isWeekday && (
    (etTime >= 4 && etTime < 9.5) || (etTime >= 16 && etTime < 20)
  );

  return { isOpen, isPrePost, isWeekday };
}

// ── MARKET DATA MANUAL REFRESH ───────────────────────────
let lastMarketFetch = 0;

function getMarketCacheMs() {
  // During market hours: refresh every 2 hours
  // Outside hours: no point refreshing (data is end-of-day)
  return getMarketStatus().isOpen
    ? 2 * 60 * 60 * 1000   // 2 hours during trading
    : 8 * 60 * 60 * 1000;  // 8 hours outside (basically don't auto-refresh)
}

function updateRefreshBtn() {
  const btn = document.getElementById('refreshMarketBtn');
  const status = document.querySelector('.market-status');
  if (!btn) return;

  const { isOpen, isPrePost, isWeekday } = getMarketStatus();
  const now = Date.now();
  const cacheMs = getMarketCacheMs();
  const elapsed = now - lastMarketFetch;
  const onCooldown = lastMarketFetch && elapsed < cacheMs;

  if (!isOpen) {
    btn.disabled = true;
    btn.style.opacity = '0.35';
    btn.style.cursor = 'not-allowed';
    btn.title = isPrePost
      ? 'Pre/post market — prices update at next open'
      : !isWeekday
        ? 'Market closed (weekend)'
        : 'Market closed';
    if (status) {
      status.className = 'market-status';
      status.innerHTML = isPrePost ? '&#9679; Pre/Post Market' : '&#9679; Market Closed';
    }
  } else if (onCooldown) {
    btn.disabled = true;
    btn.style.opacity = '0.35';
    btn.style.cursor = 'not-allowed';
    const remaining = Math.ceil((cacheMs - elapsed) / 60000);
    btn.title = 'Next refresh available in ~' + remaining + ' min';
  } else {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
    btn.title = '';
  }
}

function refreshMarketData() {
  const { isOpen } = getMarketStatus();
  const now = Date.now();
  const cacheMs = getMarketCacheMs();
  const onCooldown = lastMarketFetch && (now - lastMarketFetch) < cacheMs;

  if (!isOpen || onCooldown) {
    updateRefreshBtn();
    return;
  }

  // Re-run analyze() which will re-render and re-stream fresh badge data
  const btn = document.getElementById('refreshMarketBtn');
  if (btn) btn.classList.add('spinning');
  clearMarketCache(); // clear localStorage so fresh data is fetched
  analyze();
}

// ── DRAWER ───────────────────────────────────────────────
const drawerCache = {};

async function toggleDrawer(ticker, strategy, name, desc, isStock) {
  const id = 'item-' + ticker + '-' + strategy;
  const itemEl = document.getElementById(id);
  const textEl = document.getElementById('drawer-text-' + id);
  if (!itemEl || !textEl) return;
  const isOpen = itemEl.classList.contains('open');
  document.querySelectorAll('.etf-item.open').forEach(e => e.classList.remove('open'));
  if (isOpen) return;
  itemEl.classList.add('open');
  const cacheKey = id;
  if (drawerCache[cacheKey]) { textEl.textContent = drawerCache[cacheKey]; return; }
  const holdingSummary = holdings.map(h => h.ticker + ' (' + (h.shares||0) + ' shares, ' + h.pct + '% — ' + h.sector + ')').join(', ');
  const profile = getPortfolioProfile();
  const sectorSummary = Object.entries(profile.sectors).sort((a,b) => b[1]-a[1]).map(([s,p]) => s + ': ' + p + '%').join(', ');
  textEl.innerHTML = '<div class="etf-drawer-loading"><div class="mini-spinner"></div> Analyzing your portfolio...</div>';
  try {
    const res = await callClaudeAPI({
      messages:[{role:'user',content:'Portfolio: ' + holdingSummary + '. Sector exposure: ' + sectorSummary + '.\n\nWhy would ' + ticker + ' (' + name + ' — ' + desc + ') be a great ' + (isStock ? 'individual stock pick' : 'ETF') + ' to complement THIS specific portfolio? Reference their actual holdings and what sector gap it fills. Be direct, specific, 2-3 sentences, under 55 words. No bullet points.'}]
    });
    const rawText = await res.text();
    if (res.status === 429) {
      textEl.textContent = 'Rate limit reached — please wait a minute and try again.';
      return;
    }
    if (!res.ok) {
      console.error('[claude] HTTP ' + res.status + ':', rawText);
      textEl.textContent = 'Server error ' + res.status + ': ' + rawText.slice(0, 200);
      return;
    }
    let data;
    try { data = JSON.parse(rawText); }
    catch(e) { textEl.textContent = 'Bad response from server: ' + rawText.slice(0, 200); return; }
    const text = (data.content||[]).map(b => b.text||'').join('').trim();
    if (!text) { textEl.textContent = 'Empty response from AI. Raw: ' + rawText.slice(0, 200); return; }
    drawerCache[cacheKey] = text;
    textEl.textContent = text;
  } catch(e) {
    if (e.message === 'AI_CONSENT_DECLINED') { itemEl.classList.remove('open'); return; }
    console.error('[claude] drawer error:', e);
    textEl.textContent = 'Fetch failed: ' + (e.message || 'unknown');
  }
}

// ── SCREENSHOT IMPORT ────────────────────────────────────
const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) processImageFile(file);
});

async function handleScreenshot(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;

  const overlay = document.getElementById('scanningOverlay');
  const scanText = document.getElementById('scanText');
  const preview = document.getElementById('importPreview');
  preview.classList.remove('visible');
  overlay.classList.add('active');

  const allHoldings = [];
  let errors = [];

  for (let i = 0; i < files.length; i++) {
    scanText.textContent = files.length > 1
      ? 'Scanning screenshot ' + (i + 1) + ' of ' + files.length + '...'
      : 'Scanning portfolio...';
    try {
      const result = await processImageFile(files[i]);
      if (result && result.length > 0) {
        console.log('[screenshot ' + (i+1) + '] detected:', result.map(h => h.ticker + ':' + h.shares).join(', '));
        result.forEach(h => {
          // Merge: skip duplicates from earlier screenshots
          const existing = allHoldings.find(e => e.ticker === h.ticker);
          if (!existing) {
            allHoldings.push(h);
          } else {
            console.log('[dedup] skipping ' + h.ticker + ' (already found in earlier screenshot)');
          }
        });
      }
    } catch(err) {
      errors.push('Screenshot ' + (i + 1) + ': ' + err.message);
    }
  }

  overlay.classList.remove('active');
  event.target.value = '';

  if (allHoldings.length === 0) {
    alert('Could not detect holdings.' + (errors.length ? '\n\n' + errors.join('\n') : '') + '\n\nTip: Try clearer screenshots showing ticker symbols and values.');
    return;
  }

  // Convert shares to dollar values using LIVE prices from market data API
  const tickers = allHoldings.map(h => h.ticker);
  scanText.textContent = 'Fetching live prices...';
  overlay.classList.add('active');

  let livePrices = {};
  try {
    const priceRes = await fetch('/api/market-data?tickers=' + tickers.join(','));
    const priceData = await priceRes.json();
    for (const [ticker, val] of Object.entries(priceData)) {
      if (val && val.price) livePrices[ticker] = Number(val.price);
    }
    console.log('[live prices]', livePrices);
  } catch(e) {
    console.warn('[live prices] fetch failed, using fallback estimates:', e.message);
  }

  overlay.classList.remove('active');

  const holdingsWithValues = allHoldings.map(h => {
    const price = livePrices[h.ticker] || APPROX_PRICES[h.ticker] || 50;
    const dollarValue = (h.shares || 0) * price;
    console.log('[calc]', h.ticker, h.shares, 'shares ×', '$' + price, '=', '$' + dollarValue.toFixed(2));
    return { ...h, dollarValue };
  });

  const totalValue = holdingsWithValues.reduce((s, h) => s + h.dollarValue, 0);
  console.log('[calc] total portfolio value: $' + totalValue.toFixed(2));

  previewHoldings = holdingsWithValues.map(h => ({
    ticker: h.ticker,
    shares: h.shares || 0,
    pct: totalValue > 0 ? Math.round((h.dollarValue / totalValue) * 100 * 10) / 10 : Math.round(100 / allHoldings.length * 10) / 10,
    name: h.name || h.ticker
  })).sort((a, b) => (b.shares * (b.dollarValue || 1)) - (a.shares * (a.dollarValue || 1)));

  renderPreview();
  if (errors.length > 0 && allHoldings.length > 0) {
    document.getElementById('importNote').textContent += ' · ' + errors.length + ' screenshot(s) had issues';
  }
}

async function processImageFile(file) {
  const base64 = await fileToBase64(file);
  const mediaType = file.type || 'image/png';
  var response;
  try {
    response = await callClaudeAPI({
      messages:[{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:mediaType,data:base64}},
        {type:'text',text:'This is a screenshot from a stock brokerage app (likely Robinhood). It shows stock holdings with share counts.\n\nRead EVERY ticker and its EXACT share count as shown on screen. Be precise with decimal shares (e.g. 0.811746, 0.098814, 51.58).\n\nRespond ONLY with JSON, no other text:\n{\"holdings\":[{\"ticker\":\"HOOD\",\"shares\":51.58,\"name\":\"Robinhood Markets\"},{\"ticker\":\"QQQ\",\"shares\":1.40,\"name\":\"Invesco QQQ\"}]}\n\nRules:\n- ticker = uppercase symbol exactly as shown\n- shares = exact number shown (keep all decimals)\n- name = company name if you know it, otherwise ticker\n- Skip cash, buying power, or any non-stock items\n- If nothing detected: {\"holdings\":[],\"error\":\"Could not detect holdings\"}'}
      ]}]
    });
  } catch(e) {
    if (e.message === 'AI_CONSENT_DECLINED') return;
    throw e;
  }
  if (response.status === 429) {
    const errData = await response.json();
    document.getElementById('scanningOverlay').style.display = 'none';
    document.getElementById('errorMsg').textContent = errData.message || 'Too many requests. Please wait.';
    return;
  }
  const data = await response.json();
  const text = (data.content||[]).map(b => b.text||'').join('');
  // Extract JSON from response — model may include preamble text
  let clean = text.replace(/```json|```/g,'').trim();
  const jsonMatch = clean.match(/\{[\s\S]*"holdings"[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No valid response received.');
  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.holdings || parsed.holdings.length === 0) throw new Error(parsed.error || 'No holdings detected.');
  return parsed.holdings.map(h => ({
    ticker: (h.ticker||'').toUpperCase().replace(/[^A-Z0-9]/g,''),
    shares: h.shares || h.pct || 0,
    name: h.name || h.ticker
  })).filter(h => h.ticker.length >= 1 && h.ticker.length <= 6);
}


function fileToBase64(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function renderPreview() {
  const preview   = document.getElementById('importPreview');
  const container = document.getElementById('previewItems');
  const note      = document.getElementById('importNote');
  if (previewHoldings.length === 0) { preview.classList.remove('visible'); return; }
  container.innerHTML = previewHoldings.map((h,i) =>
    '<div class="preview-item" style="grid-template-columns:52px 1fr auto 20px;">' +
    '<span class="preview-ticker">' + escapeHTML(h.ticker) + '</span>' +
    '<span class="preview-name">' + escapeHTML(h.name) + '</span>' +
    '<span style="font-family:\'Space Mono\',monospace;font-size:11px;color:var(--muted);white-space:nowrap;">' + (h.shares ? h.shares.toLocaleString(undefined,{maximumFractionDigits:6}) + ' shares' : '') + '</span>' +
    '<button class="btn-preview-remove" onclick="removePreviewItem(' + i + ')">×</button>' +
    '</div>'
  ).join('');
  note.textContent = previewHoldings.length + ' holdings detected';
  preview.classList.add('visible');
}

function updatePreviewPct(i, val) {
  previewHoldings[i].pct = parseFloat(val)||0;
  const total = previewHoldings.reduce((s,h) => s+h.pct, 0);
  document.getElementById('importNote').textContent = previewHoldings.length + ' holdings · Total: ' + total.toFixed(1) + '%';
}

function removePreviewItem(i) {
  previewHoldings.splice(i,1);
  renderPreview();
}

function importAll() {
  // Clear existing holdings when importing a full portfolio from screenshots
  if (previewHoldings.length >= 3) {
    holdings.length = 0;
  }
  let skipped = [];
  previewHoldings.forEach(h => {
    if (!h.ticker) return;
    // Resolve ticker alias (e.g. RVI → RVTY)
    var aliasEntry = STOCK_DB[h.ticker];
    if (aliasEntry && aliasEntry.alias) h.ticker = aliasEntry.alias;
    if (holdings.find(e => e.ticker === h.ticker)) { skipped.push(h.ticker); return; }
    const info = STOCK_DB[h.ticker] || {name:h.name||h.ticker, sector:'Other', beta:1.0, cap:'unknown'};
    holdings.push({ticker:h.ticker, shares:h.shares||1, pct:0, ...info});
  });
  previewHoldings = [];
  document.getElementById('importPreview').classList.remove('visible');
  recalcPortfolioPct();
  renderHoldings();
  // Collapse the upload section after import
  var trigger = document.querySelector('.upload-compact-trigger');
  var uploadExp = document.getElementById('uploadExpanded');
  if (trigger) trigger.classList.remove('expanded');
  if (uploadExp) uploadExp.classList.remove('expanded');
  if (skipped.length > 0) document.getElementById('errorMsg').textContent = 'Duplicates skipped: ' + skipped.join(', ');
}

// ── THEME TOGGLE ─────────────────────────────────────────
function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  const el = document.getElementById('themeLabel');
  if (el) el.textContent = isLight ? 'LIGHT' : 'DARK';
  localStorage.setItem('pc_theme', isLight ? 'light' : 'dark');
}

// Init theme from localStorage
(function() {
  if (localStorage.getItem('pc_theme') === 'light') {
    document.body.classList.add('light');
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.getElementById('themeLabel');
      if (label) label.textContent = 'LIGHT';
    });
  }
})();


// ── RISK SCORE ────────────────────────────────────────────
function updateRiskScore() {
  const bar = document.getElementById('riskScoreBar');
  const fill = document.getElementById('riskScoreFill');
  const num  = document.getElementById('riskScoreNum');
  if (!bar || holdings.length === 0) { if(bar) bar.style.display='none'; return; }
  const profile = getPortfolioProfile();
  const beta = profile.beta;
  const score = Math.round(Math.min(100, Math.max(0, (beta / 2.0) * 100)));
  const color = score < 35 ? 'var(--conservative)' : score < 65 ? 'var(--moderate)' : 'var(--aggressive)';
  const label = score < 35 ? 'Conservative' : score < 65 ? 'Moderate' : score < 85 ? 'Aggressive' : 'Very High Risk';
  bar.style.display = 'flex';
  fill.style.width = score + '%';
  fill.style.background = color;
  num.textContent = label;
  num.style.color = color;
}


function updateCorrelationWarnings() {
  const el = document.getElementById('corrWarnings');
  if (!el) return;
  const tickers = holdings.map(h => h.ticker);
  const warnings = [];
  for (const [stocks, etfs, msg] of CORRELATED_PAIRS) {
    const hs = stocks.filter(t => tickers.includes(t));
    const he = etfs.filter(t => tickers.includes(t));
    if (hs.length >= 1 && he.length >= 1) {
      warnings.push(msg.replace('{stocks}', hs.join(', ')).replace('{etf}', he.join(' & ')));
    }
  }
  el.innerHTML = warnings.map(w =>
    '<div class="corr-warn"><span class="corr-icon">⚠</span><span class="corr-text">' + escapeHTML(w) + '</span></div>'
  ).join('');
}

// ── WHAT-IF SIMULATOR ─────────────────────────────────────
function toggleWhatIf() {
  const body = document.getElementById('whatifBody');
  const icon = document.getElementById('whatifToggleIcon');
  const open = body.classList.toggle('open');
  icon.textContent = open ? '▾ collapse' : '▸ expand';
  if (open) document.getElementById('whatifTicker').focus();
}

function updateWhatIfPanel() {
  const panel = document.getElementById('whatifPanel');
  if (panel) panel.style.display = holdings.length > 0 ? 'block' : 'none';
}

function runWhatIf() {
  const wiTicker = document.getElementById('whatifTicker');
  const wiPct    = document.getElementById('whatifPct');
  const result   = document.getElementById('whatifResult');
  if (!wiTicker || !wiPct || !result) return;
  const ticker = wiTicker.value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pct    = parseFloat(wiPct.value) || 0;
  if (!ticker || pct <= 0) { result.innerHTML = 'Enter a ticker to preview its impact on your portfolio.'; return; }
  const info = STOCK_DB[ticker] || {name:ticker, sector:'Other', beta:1.0};
  const currentTotal = totalAllocation();
  const remaining = Math.round((100 - currentTotal) * 10) / 10;
  if (holdings.find(h => h.ticker === ticker)) {
    result.innerHTML = '<strong style="color:var(--aggressive)">' + escapeHTML(ticker) + '</strong> is already in your portfolio.'; return;
  }
  if (currentTotal + pct > 100.05) {
    result.innerHTML = 'Only <strong class="wi-new">' + remaining + '%</strong> remaining — reduce or remove a holding first.'; return;
  }
  const simHoldings = [...holdings, {ticker, pct, ...info}];
  const simTotal = simHoldings.reduce((s,h) => s+h.pct, 0);
  let simBeta = 0; const simSectors = {};
  simHoldings.forEach(h => { simBeta += (h.beta||1)*h.pct; simSectors[h.sector]=(simSectors[h.sector]||0)+h.pct; });
  simBeta = Math.round((simBeta/simTotal)*100)/100;
  const currentBeta = getPortfolioProfile().beta;
  const betaDelta = Math.round((simBeta - currentBeta)*100)/100;
  const betaDir = betaDelta > 0 ? '▲' : betaDelta < 0 ? '▼' : '—';
  result.innerHTML =
    'Adding <strong>' + escapeHTML(ticker) + '</strong> (' + escapeHTML(info.name) + ') at <strong class="wi-new">' + pct + '%</strong>:<br>' +
    '&middot; <strong>' + escapeHTML(info.sector) + '</strong> exposure &rarr; <strong class="wi-new">' + Math.round((simSectors[info.sector]||0)/simTotal*100) + '%</strong> of portfolio<br>' +
    '&middot; Beta shift <strong class="wi-new">' + betaDir + ' ' + Math.abs(betaDelta) + '</strong> &rarr; new beta: <strong class="wi-new">' + simBeta + '</strong><br>' +
    '&middot; <strong class="wi-new">' + Math.round((100-simTotal)*10)/10 + '%</strong> remaining unallocated' +
    '<br><button class="btn-whatif-add" onclick="addFromWhatIf()">+ Add ' + escapeHTML(ticker) + ' to Portfolio</button>';
}

function addFromWhatIf() {
  const wiTicker = document.getElementById('whatifTicker');
  const wiPct = document.getElementById('whatifPct');
  if (!wiTicker || !wiPct) return;
  const ticker = wiTicker.value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pct = parseFloat(wiPct.value) || 0;
  if (!ticker || pct <= 0) return;
  if (holdings.find(h => h.ticker === ticker)) return;
  if (totalAllocation() + pct > 100.05) return;
  const info = STOCK_DB[ticker] || {name:ticker, sector:'Other', beta:1.0};
  holdings.push({ticker, pct: Math.round(pct*10)/10, sector: info.sector, beta: info.beta});
  renderHoldings();
  wiTicker.value = '';
  wiPct.value = '';
  document.getElementById('whatifResult').innerHTML = 'Enter a ticker to preview its impact on your portfolio.';
}

(function() {
  let whatifTimer = null;
  function debouncedWhatIf() { clearTimeout(whatifTimer); whatifTimer = setTimeout(runWhatIf, 300); }
  const wt = document.getElementById('whatifTicker');
  const wp = document.getElementById('whatifPct');
  if (wt) wt.addEventListener('input', debouncedWhatIf);
  if (wp) wp.addEventListener('input', debouncedWhatIf);
})();

// ── WHAT-IF AUTOCOMPLETE ─────────────────────────────────
(function initWhatifAutocomplete() {
  const input = document.getElementById('whatifTicker');
  const dd = document.getElementById('whatifAutocompleteDropdown');
  if (!input || !dd) return;
  const dbEntries = Object.entries(STOCK_DB);

  input.addEventListener('input', function() {
    const q = this.value.trim().toUpperCase();
    if (q.length === 0) { dd.classList.remove('open'); return; }
    const matches = dbEntries
      .filter(([ticker, info]) => ticker.startsWith(q) || info.name.toUpperCase().includes(q))
      .slice(0, 8);
    if (matches.length === 0) { dd.classList.remove('open'); return; }
    dd.innerHTML = matches.map(([ticker, info]) =>
      '<div class="autocomplete-item" data-ticker="' + escapeHTML(ticker) + '">' +
      '<span class="autocomplete-item-ticker">' + escapeHTML(ticker) + '</span>' +
      '<span class="autocomplete-item-name">' + escapeHTML(info.name) + '</span>' +
      '</div>'
    ).join('');
    dd.classList.add('open');
  });

  dd.addEventListener('click', function(e) {
    const item = e.target.closest('.autocomplete-item');
    if (item && item.dataset.ticker) {
      input.value = item.dataset.ticker;
      dd.classList.remove('open');
      document.getElementById('whatifPct').focus();
      runWhatIf();
    }
  });

  input.addEventListener('keydown', function(e) {
    const items = dd.querySelectorAll('.autocomplete-item');
    const selIdx = [...items].findIndex(i => i.classList.contains('selected'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items.forEach(i => i.classList.remove('selected'));
      const next = Math.min(selIdx + 1, items.length - 1);
      if (items[next]) { items[next].classList.add('selected'); items[next].scrollIntoView({block:'nearest'}); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items.forEach(i => i.classList.remove('selected'));
      const prev = Math.max(selIdx - 1, 0);
      if (items[prev]) { items[prev].classList.add('selected'); items[prev].scrollIntoView({block:'nearest'}); }
    } else if (e.key === 'Enter') {
      const sel = dd.querySelector('.autocomplete-item.selected');
      if (sel && dd.classList.contains('open')) {
        e.preventDefault();
        input.value = sel.dataset.ticker;
        dd.classList.remove('open');
        document.getElementById('whatifPct').focus();
        runWhatIf();
      }
    } else if (e.key === 'Escape') {
      dd.classList.remove('open');
    }
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.autocomplete-wrapper')) dd.classList.remove('open');
  });
})();

// ── PORTFOLIO SAVE/LOAD ───────────────────────────────────
const MAX_SLOTS = 3;
function getSavedPortfolios() { try { return JSON.parse(localStorage.getItem('pc_portfolios') || '[]'); } catch { return []; } }
function savePortfoliosLS(p) { localStorage.setItem('pc_portfolios', JSON.stringify(p)); }

// ── DEFAULT PORTFOLIO ─────────────────────────────────────
function getDefaultPortfolioIdx() {
  var portfolios = getSavedPortfolios();
  var pinned = localStorage.getItem('pc_default_portfolio');
  if (pinned != null) {
    var idx = parseInt(pinned, 10);
    if (!isNaN(idx) && idx >= 0 && idx < portfolios.length) return idx;
    localStorage.removeItem('pc_default_portfolio');
  }
  var last = localStorage.getItem('pc_last_portfolio');
  if (last != null) {
    var idx2 = parseInt(last, 10);
    if (!isNaN(idx2) && idx2 >= 0 && idx2 < portfolios.length) return idx2;
    localStorage.removeItem('pc_last_portfolio');
  }
  return -1;
}

function setDefaultPortfolio(idx) {
  localStorage.setItem('pc_default_portfolio', String(idx));
  if (typeof renderPortfolioDrawer === 'function') renderPortfolioDrawer();
  if (typeof renderPortfolioStrip === 'function') renderPortfolioStrip(null);
}

function toggleDefaultPortfolio(idx) {
  var current = localStorage.getItem('pc_default_portfolio');
  if (current != null && parseInt(current, 10) === idx) {
    localStorage.removeItem('pc_default_portfolio');
  } else {
    localStorage.setItem('pc_default_portfolio', String(idx));
  }
  if (typeof renderPortfolioDrawer === 'function') renderPortfolioDrawer();
  if (typeof renderPortfolioStrip === 'function') renderPortfolioStrip(null);
}

// ── SIDEBAR ───────────────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarBackdrop').classList.add('open');
  renderSidebarContent();
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
}

// Close sidebar on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeSidebar();
});

function renderSidebarContent() {
  renderSidebarUser();
  renderSidebarSettings();
  renderSidebarAccount();
}

function renderSidebarUser() {
  const el = document.getElementById('sidebarUser');
  if (!el) return;
  if (typeof currentUser !== 'undefined' && currentUser) {
    const name = currentUser.name || currentUser.email.split('@')[0];
    const email = currentUser.email || '';
    let avatarHTML;
    if (currentUser.picture) {
      avatarHTML = '<img class="sidebar-user-avatar" src="' + escapeHTML(currentUser.picture) + '" onerror="this.style.display=\'none\'" />';
    } else {
      const initial = (name || email || '?')[0].toUpperCase();
      avatarHTML = '<div class="sidebar-user-avatar initials">' + initial + '</div>';
    }
    const proBadge = isProUser() ? '<div class="sidebar-pro-badge">✦ Pro Member</div>' : '';
    el.innerHTML =
      '<div class="sidebar-user-info">' +
        avatarHTML +
        '<div class="sidebar-user-details">' +
          '<div class="sidebar-user-name">' + escapeHTML(name) + '</div>' +
          '<div class="sidebar-user-email">' + escapeHTML(email) + '</div>' +
        '</div>' +
      '</div>' +
      proBadge;
  } else {
    el.innerHTML =
      '<div class="sidebar-user-name" style="margin-bottom:4px;">Guest</div>' +
      '<button class="sidebar-signin-btn" onclick="closeSidebar();showAuthModalOptimized();">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v2h20v-2c0-3.3-6.7-5-10-5z" fill="currentColor"/></svg>' +
        'Sign In' +
      '</button>';
  }
}

function getPortfolioRiskColor(holdingsArr) {
  if (!holdingsArr || holdingsArr.length === 0) return 'var(--muted)';
  let beta = 0, total = 0;
  holdingsArr.forEach(h => { beta += (h.beta || (STOCK_DB[h.ticker]||{}).beta || 1.0) * h.pct; total += h.pct; });
  if (total === 0) return 'var(--muted)';
  const score = Math.round(Math.min(100, Math.max(0, ((beta / total) / 2.0) * 100)));
  return score < 35 ? 'var(--conservative)' : score < 65 ? 'var(--moderate)' : 'var(--aggressive)';
}

function renderSidebarPortfolios() {
  const el = document.getElementById('sidebarPortfolios');
  const actionsEl = document.getElementById('sidebarPortfolioActions');
  if (!el) return;
  const portfolios = getSavedPortfolios();

  if (portfolios.length === 0) {
    el.innerHTML = '<div class="sidebar-empty">No saved portfolios</div>';
  } else {
    el.innerHTML = portfolios.map((p, i) => {
      const riskColor = getPortfolioRiskColor(p.holdings);
      return '<div class="sidebar-slot' + (i === _activePortfolioIdx ? ' active' : '') + '" id="sb-slot-' + i + '" onclick="loadPortfolio(' + i + ')" style="border-left:3px solid ' + riskColor + ';">' +
      '<span class="slot-name" id="sb-slot-name-' + i + '">' + escapeHTML(p.name) + '</span>' +
      '<span class="slot-count">' + p.holdings.length + '</span>' +
      '<div class="slot-actions">' +
      '<button class="slot-btn" onclick="event.stopPropagation();startRenameSlot(' + i + ',\'sb-\')" title="Rename">✎</button>' +
      '<button class="slot-btn danger" onclick="event.stopPropagation();deletePortfolio(' + i + ')" title="Delete">&times;</button>' +
      '</div></div>';
    }).join('');
  }

  if (actionsEl) {
    let html = portfolios.length >= MAX_SLOTS ? '' : '<button class="sidebar-btn" onclick="savePortfolio()">＋ Save Current</button>';
    actionsEl.innerHTML = html;
  }
}

function renderSidebarSettings() {
  const el = document.getElementById('sidebarSettings');
  if (!el) return;
  const isDark = !document.body.classList.contains('light');
  el.innerHTML =
    '<div class="sidebar-settings-row">' +
      '<span class="sidebar-settings-label">' + (isDark ? '🌙' : '☀️') + ' Theme</span>' +
      '<div class="theme-toggle" onclick="toggleTheme();renderSidebarSettings();" style="position:static;transform:none;">' +
        '<span>' + (isDark ? 'DARK' : 'LIGHT') + '</span>' +
        '<div class="theme-toggle-track"><div class="theme-toggle-thumb"></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="sidebar-settings-row">' +
      '<button class="sidebar-btn" onclick="restorePurchases()" style="width:100%;">🔄 Restore Purchases</button>' +
    '</div>';
}

function renderSidebarAccount() {
  const el = document.getElementById('sidebarAccount');
  if (!el) return;
  if (typeof currentUser !== 'undefined' && currentUser) {
    el.innerHTML =
      '<div class="sidebar-section-title">Account</div>' +
      '<button class="sidebar-account-btn sign-out" onclick="signOut();closeSidebar();">Sign Out</button>' +
      '<button class="sidebar-account-btn delete-account" onclick="deleteAccount()">Delete Account</button>';
  } else {
    el.innerHTML = '';
  }
}

async function savePortfolio() {
  if (holdings.length === 0) { showToast('Add holdings first!'); return; }
  const portfolios = getSavedPortfolios();

  // If editing an existing portfolio, overwrite it (with confirmation)
  if (_activePortfolioIdx >= 0 && portfolios[_activePortfolioIdx]) {
    var pName = portfolios[_activePortfolioIdx].name;
    if (!confirm('Overwrite "' + pName + '" with current holdings?')) return;
    portfolios[_activePortfolioIdx].holdings = JSON.parse(JSON.stringify(holdings));
    savePortfoliosLS(portfolios);
    _activePortfolioSnapshot = JSON.stringify(holdings);
    renderSidebarPortfolios();
    if (typeof renderPortfolioStrip === 'function') renderPortfolioStrip(null);
    if (typeof renderPortfolioOverview === 'function') renderPortfolioOverview();
    showToast('✓ "' + pName + '" updated!');
    return;
  }

  // New portfolio
  if (portfolios.length >= MAX_SLOTS) { showToast('Max ' + MAX_SLOTS + ' portfolios — delete one to save a new one.'); return; }

  // Prevent duplicate: check if current holdings match any existing portfolio
  const currentKey = holdings.map(function(h) { return h.ticker + ':' + h.pct; }).sort().join(',');
  for (let i = 0; i < portfolios.length; i++) {
    const existingKey = (portfolios[i].holdings || []).map(function(h) { return h.ticker + ':' + h.pct; }).sort().join(',');
    if (currentKey === existingKey) {
      showToast('This portfolio already exists as "' + portfolios[i].name + '"');
      return;
    }
  }

  const name = 'Portfolio ' + (portfolios.length + 1);
  portfolios.push({name, holdings: JSON.parse(JSON.stringify(holdings))});
  savePortfoliosLS(portfolios);
  _activePortfolioIdx = portfolios.length - 1;
  _activePortfolioSnapshot = JSON.stringify(holdings);
  localStorage.setItem('pc_last_portfolio', String(_activePortfolioIdx));
  renderSidebarPortfolios();
  if (typeof renderPortfolioStrip === 'function') renderPortfolioStrip(null);
  if (typeof renderPortfolioOverview === 'function') renderPortfolioOverview();
  showToast('✓ Portfolio saved!');
}

function loadPortfolio(idx, silent) {
  const portfolios = getSavedPortfolios();
  if (!portfolios[idx]) return;
  holdings = JSON.parse(JSON.stringify(portfolios[idx].holdings));
  // Ensure shares field exists (backward compat with old pct-only portfolios)
  holdings.forEach(function(h) { if (!h.shares && h.pct) h.shares = 1; });
  _activePortfolioIdx = idx;
  _activePortfolioSnapshot = JSON.stringify(holdings);
  localStorage.setItem('pc_last_portfolio', String(idx));
  // Auto-switch to chart view when loading a portfolio with 3+ holdings
  if (holdings.length >= 3) {
    _holdingsView = 'chart';
    document.querySelectorAll('.view-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === 'chart');
    });
  }
  recalcPortfolioPct();
  renderHoldings();
  if (_holdingsView === 'chart' && holdings.length >= 3) {
    fetchAndRenderSparklines();
  }
  if (typeof renderPortfolioOverview === 'function') renderPortfolioOverview();
  closeSidebar();
  if (!silent) showToast('✓ Loaded: ' + escapeHTML(portfolios[idx].name));
}

function deletePortfolio(idx) {
  const portfolios = getSavedPortfolios();
  const name = portfolios[idx]?.name || 'this portfolio';
  if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
  const deleted = portfolios.splice(idx, 1)[0];
  savePortfoliosLS(portfolios);
  if (_activePortfolioIdx === idx) {
    _activePortfolioIdx = -1;
    _activePortfolioSnapshot = null;
    if (typeof hidePortfolioOverview === 'function') hidePortfolioOverview();
    // Clear loaded holdings since active portfolio was deleted
    holdings.length = 0;
    renderHoldings();
    expandInputSections();
    if (typeof expandHoldingsPanel === 'function') expandHoldingsPanel();
  } else if (_activePortfolioIdx > idx) {
    _activePortfolioIdx--;
  }
  showToast('Portfolio deleted.');
}

function renamePortfolio(idx, newName) {
  const portfolios = getSavedPortfolios();
  if (!portfolios[idx]) return;
  portfolios[idx].name = newName || portfolios[idx].name;
  savePortfoliosLS(portfolios);
}

function startRenameSlot(i, prefix) {
  prefix = prefix || '';
  const nameEl = document.getElementById(prefix + 'slot-name-' + i);
  if (!nameEl) return;
  const current = nameEl.textContent;
  nameEl.outerHTML =
    '<input class="slot-name-input" id="' + prefix + 'slot-name-' + i + '" value="' + escapeHTML(current) + '" maxlength="24"' +
    ' onclick="event.stopPropagation()"' +
    ' onblur="finishRenameSlot(' + i + ', this.value, \'' + prefix + '\')"' +
    ' onkeydown="if(event.key===\'Enter\')this.blur();if(event.key===\'Escape\')this.blur();" />';
  const input = document.getElementById(prefix + 'slot-name-' + i);
  if (input) { input.focus(); input.select(); }
}

function finishRenameSlot(i, newName, prefix) {
  renamePortfolio(i, newName.trim() || ('Portfolio ' + (i + 1)));
  renderSidebarPortfolios();
}


function collapseInputSections() {
  const el = document.getElementById('inputSections');
  if (el) el.style.display = 'none';
}
function expandInputSections() {
  const el = document.getElementById('inputSections');
  if (el) el.style.display = '';
}

function loadExample(key) {
  const example = EXAMPLE_PORTFOLIOS[key];
  if (!example) return;
  holdings = example.map(e => { const info = STOCK_DB[e.ticker] || {name:e.ticker,sector:'Other',beta:1.0,cap:'unknown'}; return {ticker:e.ticker,shares:e.shares||1,pct:0,...info}; });
  _activePortfolioIdx = -1;
  _activePortfolioSnapshot = null;
  if (typeof hidePortfolioOverview === 'function') hidePortfolioOverview();
  recalcPortfolioPct();
  renderHoldings();
  collapseInputSections();
}

// ── SHARE PORTFOLIO ───────────────────────────────────────
async function sharePortfolio() {
  if (holdings.length === 0) { showToast('Add holdings first!'); return; }
  const encoded = holdings.map(h => h.ticker + '-' + (h.shares || 1)).join('_');
  const url = window.location.origin + window.location.pathname + '?p=' + encoded;
  var totalEq = getTotalEquity();
  const summary = holdings.slice().sort(function(a,b) { return ((b.shares||0)*(_holdingsPriceCache[b.ticker]||0)) - ((a.shares||0)*(_holdingsPriceCache[a.ticker]||0)); }).map(h => h.ticker + ' ' + (h.shares||1) + ' shares').join(', ');
  const text = 'My portfolio: ' + summary;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Portfolio Compass', text: text, url: url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled
    }
  }
  // Clipboard fallback for desktop browsers
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard!');
  } catch (e) {
    prompt('Copy this link:', url);
  }
}

function showToast(msg) {
  const toast = document.getElementById('shareToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// Load from URL on page load
(function loadFromURL() {
  const p = new URLSearchParams(window.location.search).get('p');
  if (!p) return;
  try {
    const parsed = p.split('_').map(s => { const [t,val] = s.split('-'); return {ticker:(t||'').toUpperCase().replace(/[^A-Z0-9.]/g,''), shares:parseFloat(val)||1}; }).filter(h=>h.ticker).slice(0, 50);
    if (!parsed.length) return;
    holdings = parsed.map(e => { const info = STOCK_DB[e.ticker]||{name:e.ticker,sector:'Other',beta:1.0,cap:'unknown'}; return {ticker:e.ticker,shares:e.shares,pct:0,...info}; });
    recalcPortfolioPct();
    renderHoldings();
    setTimeout(analyze, 400);
  } catch(e) {}
})();

// ── EXPORT PDF ────────────────────────────────────────────
// ── ONBOARDING INIT ───────────────────────────────────────
(function initOnboarding() {
  const banner = document.getElementById('onboardingBanner');
  if (!banner) return;
  if (holdings.length > 0) banner.style.display = 'none';
})();

// Sidebar portfolios are rendered on-demand when sidebar opens

// ── PANEL COLLAPSE/EXPAND ────────────────────────────────
function togglePanel(headerEl) {
  const body = headerEl.nextElementSibling;
  if (!body || !body.classList.contains('panel-body')) return;
  const chevron = headerEl.querySelector('.panel-chevron');
  const hint = headerEl.querySelector('.panel-expand-hint');
  body.classList.toggle('panel-body-collapsed');
  if (chevron) chevron.classList.toggle('panel-chevron-open');
  if (hint) hint.textContent = body.classList.contains('panel-body-collapsed') ? 'tap to expand' : 'tap to collapse';
}

// ── STRATEGY CARD COLLAPSE/EXPAND ────────────────────────
function toggleStrategyCard(headerEl) {
  const list = headerEl.nextElementSibling;
  if (!list) return;
  const chevron = headerEl.querySelector('.strategy-chevron');
  const hint = headerEl.querySelector('.strategy-expand-hint');
  const isCollapsing = !list.classList.contains('strategy-collapsed');
  list.classList.toggle('strategy-collapsed');
  if (chevron) chevron.classList.toggle('strategy-chevron-open');
  if (hint) hint.textContent = isCollapsing ? 'tap to expand' : 'tap to collapse';
  // Reset show-more when collapsing so it reopens at original count
  if (isCollapsing) {
    list.querySelectorAll('.show-more-items').forEach(function(p) { p.classList.remove('open'); });
    list.querySelectorAll('.btn-show-more').forEach(function(b) { b.classList.remove('open'); b.innerHTML = '✦ See more stocks'; b.dataset.shown = '0'; });
    list.querySelectorAll('.etf-item.show-more-hidden').forEach(function(el) { el.classList.add('show-more-hidden'); });
  }
}

// ── SHOW MORE TOGGLE (reveals 5 at a time) ──────────────
async function toggleShowMore(type) {
  const panel = document.getElementById('show-more-' + type);
  const btn   = document.getElementById('show-more-btn-' + type);
  if (!panel || !btn) return;

  // If panel is still empty, fetch extra picks and render them all as hidden
  if (panel.querySelectorAll(':scope > .etf-item').length === 0) {
    btn.innerHTML = '<span class="mini-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid var(--muted);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;margin-right:6px;vertical-align:middle;"></span> Loading...';
    const proData = await fetchProPicks();
    if (!proData) {
      btn.innerHTML = '✦ See more stocks';
      showToast('Failed to load extra picks. Try again.');
      return;
    }
    const extraHTML = _renderProPicksForStrategy(type, proData);
    if (extraHTML) {
      panel.insertAdjacentHTML('afterbegin', extraHTML);
      // Hide all initially
      panel.querySelectorAll('.etf-item').forEach(function(el) { el.classList.add('show-more-hidden'); });
    }
    btn.dataset.shown = '0';
  }

  panel.classList.add('open');
  const allItems = panel.querySelectorAll('.etf-item');
  const shown = parseInt(btn.dataset.shown || '0');
  const nextShown = Math.min(shown + 5, allItems.length);

  // Reveal next batch of 5
  for (let i = shown; i < nextShown; i++) {
    allItems[i].classList.remove('show-more-hidden');
  }
  btn.dataset.shown = String(nextShown);

  const remaining = allItems.length - nextShown;
  if (remaining > 0) {
    btn.innerHTML = '✦ See more stocks (' + remaining + ' more)';
  } else {
    btn.style.display = 'none';
  }
}

// ── RENDER PRO PICKS INTO SHOW-MORE CONTAINER ────────────
// Called after fetching /api/pro-picks to dynamically render extra items
// Reuses the buildItemHTML function from the analyze() closure via a global reference
let _lastBuildItemHTML = null;
let _lastMarketData = null;

function _renderProPicksForStrategy(type, proData) {
  if (!proData || !_lastBuildItemHTML) return '';
  const ownedTickers = holdings.map(h => h.ticker);
  const profile = getPortfolioProfile();
  const ownedSectors = Object.keys(profile.sectors).filter(s => (profile.sectors[s]||0) > 5);

  const riskAllowed = {
    aggressive:['High','Very High','Medium'],
    moderate:['Medium','Low','High'],
    conservative:['Low','Medium'],
  }[type] || ['Medium'];

  // Score and filter pro stock picks
  const picks = (proData.stocks || [])
    .filter(p => !ownedTickers.includes(p.ticker) && !p.avoidIfHeld.some(t => ownedTickers.includes(t)) && riskAllowed.includes(p.risk))
    .map(p => {
      let score = 50;
      if (!ownedSectors.includes(p.sector)) score += 28;
      else if ((profile.sectors[p.sector]||0) < 10) score += 14;
      if (p.risk === 'Low') score += 6;
      if (p.risk === 'Very High') score -= 8;
      const md = _lastMarketData && _lastMarketData[p.ticker];
      if (md) score += Math.round((md.momentum - 50) * 0.3);
      return {...p, score, isStock:true};
    })
    .sort((a,b) => b.score - a.score)
    .slice(0,20);

  // Score and filter pro ETFs for this strategy
  const proEtfs = (proData.etfs && proData.etfs[type]) || [];
  const etfs = proEtfs
    .filter(e => !ownedTickers.includes(e.ticker))
    .map(e => ({...e, score:70, isStock:false}));

  const allExtraRaw = [...etfs, ...picks].slice(0, 20);
  // Round down to multiple of 5 for clean "see more" batches
  const allExtra = allExtraRaw.slice(0, Math.floor(allExtraRaw.length / 5) * 5);
  if (allExtra.length === 0) return '';

  return allExtra.map(item => _lastBuildItemHTML(item, type, _lastMarketData)).join('');
}

// ── UPGRADE MODAL ────────────────────────────────────────
function showPaywall(trigger) {
  const msgs = {
    ai:        'You\'ve used your 3 free AI explanations.',
    pdf:       'PDF export is a Pro feature.',
    sync:      'Cloud sync is a Pro feature.',
    showmore:  'Expanded picks are a Pro feature.',
    header:    'Upgrade to unlock all Pro features.',
    screenshot:'Screenshot import is a Pro feature.',
  };
  const msgEl = document.getElementById('paywallMsg');
  if (msgEl) msgEl.textContent = msgs[trigger] || 'Upgrade to unlock all Pro features.';
  const modal = document.getElementById('paywallModal');

  // Reset all elements to default (in case iOS mode was set on a previous open)
  modal.querySelectorAll('[id^="tier-"]').forEach(function(el) { el.style.display = ''; });
  modal.querySelectorAll('.pw-features').forEach(function(el) { el.style.display = ''; });
  modal.querySelectorAll('.pw-restore').forEach(function(el) { el.style.display = ''; });
  const confirmBtn = document.getElementById('paywallConfirmBtn');
  if (confirmBtn) {
    confirmBtn.style.background = '';
    confirmBtn.style.color = '';
    confirmBtn.style.cursor = '';
  }

  // Inside iOS app: hide purchase tiers & web payment links (Apple Guideline 3.1.1)
  // But keep Restore Purchases visible (Apple requires it)
  if (typeof _isIOSApp !== 'undefined' && _isIOSApp) {
    modal.querySelectorAll('[id^="tier-"]').forEach(function(el) { el.style.display = 'none'; });
    modal.querySelectorAll('.pw-features').forEach(function(el) { el.style.display = 'none'; });
    if (confirmBtn) {
      confirmBtn.textContent = 'OK';
      confirmBtn.onclick = function() { closePaywall(); };
      confirmBtn.style.background = '#1e2430';
      confirmBtn.style.color = '#8a9ab8';
      confirmBtn.style.cursor = 'default';
    }
    if (msgEl) msgEl.textContent = 'This feature requires a Pro subscription.\nManage subscriptions in Settings \u203a Apple ID \u203a Subscriptions.';
    // Make Restore Purchases more prominent on iOS
    modal.querySelectorAll('.pw-restore').forEach(function(el) { el.classList.add('pw-restore-ios'); });
  }

  modal.style.display = 'flex';
  modal.classList.add('open');
}
function closePaywall() {
  const pm2=document.getElementById('paywallModal');pm2.style.display='none';pm2.classList.remove('open');
}

// ── ENTER KEY ─────────────────────────────────────────────
document.getElementById('tickerInput').addEventListener('keydown', e => {
  const dd = document.getElementById('autocompleteDropdown');
  const items = dd.querySelectorAll('.autocomplete-item');
  const selIdx = [...items].findIndex(i => i.classList.contains('selected'));

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items.forEach(i => i.classList.remove('selected'));
    const next = Math.min(selIdx + 1, items.length - 1);
    if (items[next]) { items[next].classList.add('selected'); items[next].scrollIntoView({block:'nearest'}); }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items.forEach(i => i.classList.remove('selected'));
    const prev = Math.max(selIdx - 1, 0);
    if (items[prev]) { items[prev].classList.add('selected'); items[prev].scrollIntoView({block:'nearest'}); }
  } else if (e.key === 'Enter') {
    const sel = dd.querySelector('.autocomplete-item.selected');
    if (sel && dd.classList.contains('open')) {
      e.preventDefault();
      selectAutocomplete(sel.dataset.ticker);
    } else {
      document.getElementById('pctInput').focus();
    }
  } else if (e.key === 'Escape') {
    dd.classList.remove('open');
  }
});
document.getElementById('pctInput').addEventListener('keydown', e => { if (e.key==='Enter') addStock(); });

// ── TICKER AUTOCOMPLETE ─────────────────────────────────────
(function initAutocomplete() {
  const input = document.getElementById('tickerInput');
  const dd = document.getElementById('autocompleteDropdown');
  const dbEntries = Object.entries(STOCK_DB);

  input.addEventListener('input', function() {
    const q = this.value.trim().toUpperCase();
    if (q.length === 0) { dd.classList.remove('open'); return; }

    const matches = dbEntries
      .filter(([ticker, info]) => 
        ticker.startsWith(q) || info.name.toUpperCase().includes(q)
      )
      .slice(0, 8);

    if (matches.length === 0) { dd.classList.remove('open'); return; }

    dd.innerHTML = matches.map(([ticker, info]) =>
      '<div class="autocomplete-item" data-ticker="' + escapeHTML(ticker) + '" onclick="selectAutocomplete(\'' + escapeHTML(ticker) + '\')">' +
      '<span class="autocomplete-item-ticker">' + escapeHTML(ticker) + '</span>' +
      '<span class="autocomplete-item-name">' + escapeHTML(info.name) + '</span>' +
      '</div>'
    ).join('');
    dd.classList.add('open');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.autocomplete-wrapper')) dd.classList.remove('open');
  });
})();

function selectAutocomplete(ticker) {
  document.getElementById('tickerInput').value = ticker;
  document.getElementById('autocompleteDropdown').classList.remove('open');
  document.getElementById('pctInput').focus();
}

// ── SPARKLINE CHART VIEW ─────────────────────────────────────

var _sparkCache = {}; // in-memory per-ticker cache

function _getSparkCacheTTL(range) {
  if (range === 'live') return 3 * 1000; // 3s for live
  var isLive = typeof getMarketStatus === 'function' && getMarketStatus().isOpen;
  if (isLive && (range === '1d' || range === '5d')) return 60 * 1000; // 60s during market hours
  return 4 * 60 * 60 * 1000; // 4 hours otherwise
}

function _getSparkCached(ticker, range) {
  var key = ticker + ':' + range;
  var ttl = _getSparkCacheTTL(range);
  // Check in-memory first
  if (_sparkCache[key] && Date.now() - _sparkCache[key].ts < ttl) {
    return _sparkCache[key].data;
  }
  // Check localStorage
  try {
    var raw = localStorage.getItem('pc_sp_' + key);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < ttl) {
        _sparkCache[key] = parsed;
        return parsed.data;
      }
    }
  } catch(e) { /* ignore */ }
  return null;
}

function _setSparkCached(ticker, range, data) {
  var key = ticker + ':' + range;
  var entry = { data: data, ts: Date.now() };
  _sparkCache[key] = entry;
  try { localStorage.setItem('pc_sp_' + key, JSON.stringify(entry)); } catch(e) {}
}

function fetchSparklineData(tickers, range) {
  range = range || '1mo';
  // Separate cached vs uncached tickers
  var result = {};
  var uncached = [];
  for (var i = 0; i < tickers.length; i++) {
    var cached = _getSparkCached(tickers[i], range);
    if (cached) {
      result[tickers[i]] = cached;
    } else {
      uncached.push(tickers[i]);
    }
  }
  // If all cached, return immediately
  if (uncached.length === 0) return Promise.resolve(result);
  // Fetch only uncached tickers
  return fetch('/api/sparkline?tickers=' + uncached.join(',') + '&range=' + range)
    .then(function(res) {
      if (!res.ok) return result;
      return res.json();
    })
    .then(function(data) {
      if (!data || data.error) return result;
      for (var t in data) {
        if (data[t]) {
          result[t] = data[t];
          _setSparkCached(t, range, data[t]);
        }
      }
      return result;
    })
    .catch(function() { return Object.keys(result).length > 0 ? result : null; });
}

function renderSparklineSVG(closes, width, height, positive) {
  if (!closes || closes.length < 2) return '';
  var min = Infinity, max = -Infinity;
  for (var i = 0; i < closes.length; i++) {
    if (closes[i] < min) min = closes[i];
    if (closes[i] > max) max = closes[i];
  }
  var range = max - min || 1;
  var padY = height * 0.08;
  var usableH = height - padY * 2;
  var stepX = width / (closes.length - 1);

  var points = [];
  for (var i = 0; i < closes.length; i++) {
    var x = Math.round(i * stepX * 100) / 100;
    var y = Math.round((padY + usableH - ((closes[i] - min) / range) * usableH) * 100) / 100;
    points.push(x + ',' + y);
  }
  var polyPoints = points.join(' ');

  var color = positive ? '#22c55e' : '#ef4444';
  var gradId = 'sg' + Math.random().toString(36).substr(2, 6);

  // Build fill polygon (close the path at bottom)
  var fillPoints = polyPoints + ' ' + width + ',' + height + ' 0,' + height;

  var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.2"/>' +
    '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
    '</linearGradient></defs>' +
    '<polygon points="' + fillPoints + '" fill="url(#' + gradId + ')"/>' +
    '<polyline points="' + polyPoints + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  // Use <img> with data URI for universal iOS/Safari compatibility
  // (raw SVG innerHTML doesn't reliably render on WebKit)
  return '<img src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '" style="width:100%;height:100%;display:block;" alt="chart"/>';
}

function _renderPortfolioChart(closes, width, height, positive) {
  return renderSparklineSVG(closes, width, height, positive);
}

function fetchAndRenderSparklines() {
  var tickers = holdings.map(function(h) { return h.ticker; });
  if (tickers.length === 0) return;

  // Phase 1: Load market data first (fast — usually cached in localStorage)
  // This fills in prices + daily change immediately
  if (typeof fetchMarketDataCached === 'function') {
    fetchMarketDataCached(tickers).then(function(marketData) {
      if (!marketData) return;
      recalcPortfolioPct(marketData);
      holdings.forEach(function(h) {
        if (!marketData[h.ticker]) return;
        var md = marketData[h.ticker];
        var priceEl = document.getElementById('spark-price-' + h.ticker);
        var changeEl = document.getElementById('spark-change-' + h.ticker);
        if (priceEl) priceEl.textContent = '$' + md.price.toFixed(2);
        if (changeEl) {
          var pct = md.changePct;
          var isUp = pct >= 0;
          changeEl.textContent = (isUp ? '+' : '') + pct.toFixed(1) + '% 1D';
          changeEl.className = 'spark-change ' + (isUp ? 'up' : 'down');
        }
      });
    });
  }

  // Phase 2: Load sparkline chart SVGs in progressive chunks (5 at a time)
  function _renderSparkBatch(sparkData) {
    if (!sparkData) return;
    holdings.forEach(function(h) {
      if (!sparkData[h.ticker]) return;
      var sd = sparkData[h.ticker];
      var svgEl = document.getElementById('spark-svg-' + h.ticker);
      if (svgEl && sd.closes && sd.closes.length >= 2) {
        var first = sd.closes[0];
        var last = sd.closes[sd.closes.length - 1];
        var positive = last >= first;
        svgEl.innerHTML = renderSparklineSVG(sd.closes, 200, 50, positive);
      }
    });
  }
  var CHUNK = 5;
  for (var c = 0; c < tickers.length; c += CHUNK) {
    (function(chunk) {
      fetchSparklineData(chunk, '1d').then(_renderSparkBatch);
    })(tickers.slice(c, c + CHUNK));
  }
}

// ── REAL-TIME AUTO-REFRESH (during market hours) ─────────────
var _liveRefreshTimer = null;
var _LIVE_REFRESH_INTERVAL = 60 * 1000; // 60 seconds

function _startLiveRefresh() {
  if (_liveRefreshTimer) return; // already running
  _liveRefreshTimer = setInterval(function() {
    if (typeof getMarketStatus !== 'function') return;
    if (!getMarketStatus().isOpen) {
      _stopLiveRefresh();
      return;
    }
    if (holdings.length === 0) return;

    // Silently refresh prices on sparkline cards
    var tickers = holdings.map(function(h) { return h.ticker; });
    if (typeof fetchMarketDataCached === 'function') {
      fetchMarketDataCached(tickers).then(function(marketData) {
        if (!marketData) return;
        // Update price cache for equity calculations
        recalcPortfolioPct(marketData);
        holdings.forEach(function(h) {
          if (!marketData[h.ticker]) return;
          var md = marketData[h.ticker];
          var priceEl = document.getElementById('spark-price-' + h.ticker);
          var changeEl = document.getElementById('spark-change-' + h.ticker);
          if (priceEl) priceEl.textContent = '$' + md.price.toFixed(2);
          if (changeEl) {
            var pct = md.changePct;
            var isUp = pct >= 0;
            changeEl.textContent = (isUp ? '+' : '') + pct.toFixed(1) + '% 1D';
            changeEl.className = 'spark-change ' + (isUp ? 'up' : 'down');
          }
        });
      });
    }

    // Refresh sparkline chart SVGs (1d range)
    var CHUNK = 5;
    for (var c = 0; c < tickers.length; c += CHUNK) {
      (function(chunk) {
        fetchSparklineData(chunk, '1d').then(function(sparkData) {
          if (!sparkData) return;
          holdings.forEach(function(h) {
            if (!sparkData[h.ticker]) return;
            var sd = sparkData[h.ticker];
            var svgEl = document.getElementById('spark-svg-' + h.ticker);
            if (svgEl && sd.closes && sd.closes.length >= 2) {
              var first = sd.closes[0];
              var last = sd.closes[sd.closes.length - 1];
              svgEl.innerHTML = renderSparklineSVG(sd.closes, 200, 50, last >= first);
            }
          });
        });
      })(tickers.slice(c, c + CHUNK));
    }

    // Refresh portfolio overview chart if on 1D view
    var chartArea = document.getElementById('portfolioOverviewChartArea');
    if (chartArea) {
      var activeBtn = document.querySelector('#portfolioOverviewChart .chart-range-btn.active');
      var range = activeBtn ? activeBtn.dataset.range : '1d';
      if (range === '1d') loadPortfolioChartRange('1d');
    }

    // Update market status badge
    if (typeof updateHoldingsMarketStatus === 'function') updateHoldingsMarketStatus();

    // Update portfolio strip performance
    if (typeof fetchPortfolioPerformance === 'function') {
      fetchPortfolioPerformance().then(function(pm) {
        if (pm && typeof renderPortfolioStrip === 'function') renderPortfolioStrip(pm);
      });
    }
  }, _LIVE_REFRESH_INTERVAL);
}

function _stopLiveRefresh() {
  if (_liveRefreshTimer) {
    clearInterval(_liveRefreshTimer);
    _liveRefreshTimer = null;
  }
}

// Start live refresh check on page load and when holdings change
(function initLiveRefresh() {
  function checkAndStart() {
    if (typeof getMarketStatus === 'function' && getMarketStatus().isOpen && holdings.length > 0) {
      _startLiveRefresh();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(checkAndStart, 3000); });
  } else {
    setTimeout(checkAndStart, 3000);
  }
  // Also re-check every 5 minutes in case market opens/closes
  setInterval(function() {
    if (typeof getMarketStatus === 'function' && getMarketStatus().isOpen && holdings.length > 0) {
      _startLiveRefresh();
    } else {
      _stopLiveRefresh();
    }
  }, 5 * 60 * 1000);
})();

// ── EXPANDED CHART MODAL ────────────────────────────────────

var _chartModalEl = null;

function _ensureChartModal() {
  if (_chartModalEl) return _chartModalEl;
  var overlay = document.createElement('div');
  overlay.className = 'chart-modal-overlay';
  overlay.id = 'chartModalOverlay';
  overlay.onclick = function(e) {
    if (e.target === overlay) closeExpandedChart();
  };
  overlay.innerHTML =
    '<div class="chart-modal-card">' +
      '<div class="chart-modal-header">' +
        '<div>' +
          '<div class="chart-modal-ticker" id="chartModalTicker"></div>' +
          '<div class="chart-modal-name" id="chartModalName"></div>' +
          '<div class="chart-modal-sector" id="chartModalSector"></div>' +
          '<div class="chart-modal-price-row">' +
            '<span class="chart-modal-price" id="chartModalPrice">--</span>' +
            '<span class="chart-modal-change" id="chartModalChange"></span>' +
          '</div>' +
          '<div class="chart-modal-alloc" id="chartModalAlloc"></div>' +
        '</div>' +
        '<button class="chart-modal-close" onclick="closeExpandedChart()">×</button>' +
      '</div>' +
      '<div class="chart-modal-ranges" id="chartModalRanges">' +
        '<button class="chart-range-btn active" data-range="1d" onclick="loadChartRange(this.parentElement.dataset.ticker,\'1d\')">1D</button>' +
        '<button class="chart-range-btn" data-range="5d" onclick="loadChartRange(this.parentElement.dataset.ticker,\'5d\')">1W</button>' +
        '<button class="chart-range-btn" data-range="1mo" onclick="loadChartRange(this.parentElement.dataset.ticker,\'1mo\')">1M</button>' +
        '<button class="chart-range-btn" data-range="3mo" onclick="loadChartRange(this.parentElement.dataset.ticker,\'3mo\')">3M</button>' +
      '</div>' +
      '<div class="chart-modal-chart" id="chartModalChart">' +
        '<div class="spark-shimmer" style="height:200px"></div>' +
      '</div>' +
      '<div class="chart-modal-stats" id="chartModalStats"></div>' +
      '<div class="chart-modal-news" id="chartModalNews"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  _chartModalEl = overlay;
  return overlay;
}

function showExpandedChart(ticker) {
  var overlay = _ensureChartModal();
  var holding = holdings.find(function(h) { return h.ticker === ticker; });
  if (!holding) return;
  var dbEntry = STOCK_DB[ticker] || {};
  var sectorColor = SECTOR_COLORS[holding.sector] || SECTOR_COLORS['Other'] || '#475569';

  document.getElementById('chartModalTicker').textContent = ticker;
  document.getElementById('chartModalName').textContent = dbEntry.name || ticker;
  document.getElementById('chartModalSector').textContent = holding.sector;
  document.getElementById('chartModalSector').style.color = sectorColor;
  document.getElementById('chartModalAlloc').textContent = holding.pct + '% of portfolio';
  document.getElementById('chartModalRanges').dataset.ticker = ticker;
  document.getElementById('chartModalChart').innerHTML = '<div class="spark-shimmer" style="height:200px"></div>';
  document.getElementById('chartModalStats').innerHTML = '';

  // Reset range buttons — 1D active by default (scoped to modal only)
  document.getElementById('chartModalRanges').querySelectorAll('.chart-range-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.range === '1d');
  });

  // Set price from market data if available (from sparkline cards)
  var priceEl = document.getElementById('spark-price-' + ticker);
  if (priceEl && priceEl.textContent !== '--') {
    document.getElementById('chartModalPrice').textContent = priceEl.textContent;
  } else {
    document.getElementById('chartModalPrice').textContent = '--';
  }
  var changeEl = document.getElementById('spark-change-' + ticker);
  if (changeEl && changeEl.textContent) {
    var mc = document.getElementById('chartModalChange');
    mc.textContent = changeEl.textContent;
    mc.className = 'chart-modal-change ' + (changeEl.classList.contains('up') ? 'up' : 'down');
  } else {
    document.getElementById('chartModalChange').textContent = '';
    document.getElementById('chartModalChange').className = 'chart-modal-change';
  }

  // Show the modal
  requestAnimationFrame(function() {
    overlay.classList.add('open');
  });

  // Load chart data
  loadChartRange(ticker, '1d');

  // Load news for this ticker
  loadTickerNews(ticker);
}

function loadChartRange(ticker, range) {
  var chartEl = document.getElementById('chartModalChart');
  var statsEl = document.getElementById('chartModalStats');
  chartEl.innerHTML = '<div class="spark-shimmer" style="height:200px"></div>';
  statsEl.innerHTML = '';

  // Update active range button (scoped to modal only)
  var rangesEl = document.getElementById('chartModalRanges');
  if (rangesEl) rangesEl.querySelectorAll('.chart-range-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.range === range);
  });

  fetchSparklineData([ticker], range).then(function(data) {
    if (!data || !data[ticker] || !data[ticker].closes || data[ticker].closes.length < 2) {
      chartEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--muted);font-size:12px;">No data available</div>';
      return;
    }
    var sd = data[ticker];
    var closes = sd.closes;
    var first = closes[0];
    var last = closes[closes.length - 1];
    var positive = last >= first;
    chartEl.innerHTML = renderSparklineSVG(closes, 500, 200, positive);

    // Compute stats
    var high = -Infinity, low = Infinity;
    for (var i = 0; i < closes.length; i++) {
      if (closes[i] > high) high = closes[i];
      if (closes[i] < low) low = closes[i];
    }
    var rangeChange = ((last - first) / first * 100);

    statsEl.innerHTML =
      '<div class="chart-stat"><span class="chart-stat-label">High</span><span class="chart-stat-value">$' + high.toFixed(2) + '</span></div>' +
      '<div class="chart-stat"><span class="chart-stat-label">Low</span><span class="chart-stat-value">$' + low.toFixed(2) + '</span></div>' +
      '<div class="chart-stat"><span class="chart-stat-label">Open</span><span class="chart-stat-value">$' + first.toFixed(2) + '</span></div>' +
      '<div class="chart-stat"><span class="chart-stat-label">Change</span><span class="chart-stat-value" style="color:' + (rangeChange >= 0 ? '#22c55e' : '#ef4444') + '">' + (rangeChange >= 0 ? '+' : '') + rangeChange.toFixed(2) + '%</span></div>';

    // Also update the modal price to last close if market data wasn't available
    var modalPrice = document.getElementById('chartModalPrice');
    if (modalPrice && modalPrice.textContent === '--') {
      modalPrice.textContent = '$' + last.toFixed(2);
    }
  });
}

function closeExpandedChart() {
  var overlay = document.getElementById('chartModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

// ── STOCK NEWS IN CHART MODAL ────────────────────────────────

function _timeAgo(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  var diff = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return Math.floor(diff / 604800) + 'w ago';
}

function loadTickerNews(ticker) {
  var newsEl = document.getElementById('chartModalNews');
  if (!newsEl) return;
  newsEl.innerHTML = '<div class="news-loading">Loading news...</div>';

  fetch('/api/stock-news?ticker=' + encodeURIComponent(ticker))
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data[ticker] || data[ticker].length === 0) {
        newsEl.innerHTML = '<div class="news-empty">No recent news</div>';
        return;
      }
      var articles = data[ticker];
      var html = '<div class="chart-news-label">Recent News</div>';
      articles.forEach(function(a) {
        var ago = _timeAgo(a.date);
        html += '<a class="news-item" href="' + escapeHTML(a.url) + '" target="_blank" rel="noopener">'
          + '<div class="news-item-title">' + escapeHTML(a.title) + '</div>'
          + '<div class="news-item-meta">' + escapeHTML(a.source) + (ago ? ' \u00b7 ' + ago : '') + '</div>'
          + '</a>';
      });
      newsEl.innerHTML = html;
    })
    .catch(function() {
      newsEl.innerHTML = '<div class="news-empty">News unavailable</div>';
    });
}

// ── PORTFOLIO OVERVIEW CHART ─────────────────────────────────
// Shows a composite weighted performance chart when a saved portfolio is loaded

function computePortfolioLine(sparkData, holdingsArr) {
  // Collect holdings that have sparkline data
  var valid = [];
  for (var i = 0; i < holdingsArr.length; i++) {
    var h = holdingsArr[i];
    if (sparkData[h.ticker] && sparkData[h.ticker].closes && sparkData[h.ticker].closes.length >= 2) {
      valid.push({ pct: h.pct, closes: sparkData[h.ticker].closes });
    }
  }
  if (valid.length === 0) return null;

  // Find the shortest series length so all align
  var minLen = Infinity;
  for (var j = 0; j < valid.length; j++) {
    if (valid[j].closes.length < minLen) minLen = valid[j].closes.length;
  }

  // Normalize each to base-1 and compute weighted sum
  var totalWeight = 0;
  for (var k = 0; k < valid.length; k++) totalWeight += valid[k].pct;
  if (totalWeight === 0) return null;

  var portfolioLine = [];
  for (var t = 0; t < minLen; t++) {
    var val = 0;
    for (var v = 0; v < valid.length; v++) {
      var base = valid[v].closes[0];
      if (base === 0) base = 1;
      var normalized = valid[v].closes[t] / base;
      val += (valid[v].pct / totalWeight) * normalized;
    }
    portfolioLine.push(val);
  }

  var first = portfolioLine[0];
  var last = portfolioLine[portfolioLine.length - 1];
  return { closes: portfolioLine, positive: last >= first, changePct: ((last - first) / first) * 100 };
}

function renderPortfolioOverview() {
  var container = document.getElementById('portfolioOverviewChart');
  var inputSections = document.getElementById('inputSections');
  if (!container) return;

  if (holdings.length < 3) {
    hidePortfolioOverview();
    return;
  }

  // Ensure holdingsBody is expanded (it may be collapsed after analysis)
  if (typeof expandHoldingsPanel === 'function') expandHoldingsPanel();

  var portfolios = getSavedPortfolios();
  var pName = (_activePortfolioIdx >= 0 && portfolios[_activePortfolioIdx] && portfolios[_activePortfolioIdx].name) || 'My Portfolio';

  container.innerHTML =
    '<div class="portfolio-overview">' +
      '<div class="portfolio-overview-header">' +
        '<div class="portfolio-overview-name">' + escapeHTML(pName) + '</div>' +
        '<button class="portfolio-overview-edit" onclick="hidePortfolioOverview()">Edit</button>' +
      '</div>' +
      '<div class="portfolio-overview-ranges">' +
        '<button class="chart-range-btn chart-range-live" data-range="live" onclick="loadPortfolioChartRange(\'live\')"><span class="live-dot"></span>Live</button>' +
        '<button class="chart-range-btn active" data-range="1d" onclick="loadPortfolioChartRange(\'1d\')">1D</button>' +
        '<button class="chart-range-btn" data-range="5d" onclick="loadPortfolioChartRange(\'5d\')">1W</button>' +
        '<button class="chart-range-btn" data-range="1mo" onclick="loadPortfolioChartRange(\'1mo\')">1M</button>' +
        '<button class="chart-range-btn" data-range="3mo" onclick="loadPortfolioChartRange(\'3mo\')">3M</button>' +
        '<button class="chart-range-btn" data-range="1y" onclick="loadPortfolioChartRange(\'1y\')">1Y</button>' +
        '<button class="chart-range-btn" data-range="5y" onclick="loadPortfolioChartRange(\'5y\')">5Y</button>' +
      '</div>' +
      '<div class="portfolio-overview-chart" id="portfolioOverviewChartArea">' +
        '<div class="spark-shimmer" style="height:220px;border-radius:8px;"></div>' +
      '</div>' +
      '<div class="portfolio-overview-perf" id="portfolioOverviewPerf"></div>' +
    '</div>';

  container.style.display = 'block';
  // Instead of hiding all inputSections, only hide the upload trigger, form, and manual label
  // so the holdings grid (square cards) stays visible
  if (inputSections) {
    var trigger = inputSections.querySelector('.upload-compact-trigger');
    var expanded = inputSections.querySelector('#uploadExpanded');
    var manualLabel = inputSections.querySelector('#manualInputLabel');
    var stockForm = inputSections.querySelector('.stock-form');
    if (trigger) trigger.style.display = 'none';
    if (expanded) expanded.style.display = 'none';
    if (manualLabel) manualLabel.style.display = 'none';
    if (stockForm) stockForm.style.display = 'none';
  }

  // Ensure holdings are in chart view
  if (typeof _holdingsView !== 'undefined' && holdings.length >= 3) {
    _holdingsView = 'chart';
    document.querySelectorAll('.view-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.view === 'chart');
    });
    renderHoldings();
    fetchAndRenderSparklines();
  }

  // Default to 1D view
  loadPortfolioChartRange('1d');
}

// ── LIVE CHART MODE ──────────────────────────────────────────
var _chartLiveTimer = null;
var _chartLiveActive = false;
var _CHART_LIVE_INTERVAL = 5 * 1000; // 5 seconds

function _marketClosedHTML() {
  if (typeof getMarketStatus === 'function' && !getMarketStatus().isOpen) {
    return '<span class="chart-market-closed">Market Closed</span>';
  }
  return '';
}

function _totalEquityHTML() {
  var eq = getTotalEquity();
  if (eq <= 0) return '';
  return '<span class="chart-total-equity">$' + eq.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) + '</span>';
}

function _applyBubbleGlow(changePct) {
  var bubble = document.querySelector('.portfolio-overview');
  if (!bubble) return;
  bubble.classList.remove('live-glow-up', 'live-glow-down', 'live-glow-flat');
  if (typeof getMarketStatus === 'function' && getMarketStatus().isOpen) {
    var cls = changePct > 0.01 ? 'up' : changePct < -0.01 ? 'down' : 'flat';
    bubble.classList.add('live-glow-' + cls);
  }
}

function _stopChartLive() {
  _chartLiveActive = false;
  if (_chartLiveTimer) {
    clearInterval(_chartLiveTimer);
    _chartLiveTimer = null;
  }
}

function _liveChartTick() {
  var chartArea = document.getElementById('portfolioOverviewChartArea');
  var perfBadge = document.getElementById('portfolioOverviewPerf');
  if (!chartArea) { _stopChartLive(); return; }

  var tickers = holdings.map(function(h) { return h.ticker; });
  if (tickers.length === 0) return;

  // Bust caches for live data
  for (var i = 0; i < tickers.length; i++) {
    var key = tickers[i] + ':live';
    if (typeof _sparkCache !== 'undefined') delete _sparkCache[key];
    try { localStorage.removeItem('pc_sp_' + key); } catch(e) {}
  }
  var cacheKey = 'pc_market_' + tickers.slice().sort().join(',');
  try { localStorage.removeItem(cacheKey); } catch(e) {}

  // Fetch fresh sparkline + prices (live = last 1 hour, 1-min bars)
  fetchSparklineData(tickers, 'live').then(function(sparkData) {
    if (!sparkData || Object.keys(sparkData).length === 0) return;
    var result = computePortfolioLine(sparkData, holdings);
    if (!result || result.closes.length < 2) return;
    chartArea.classList.remove('chart-loading');
    chartArea.innerHTML = _renderPortfolioChart(result.closes, 500, 220, result.positive);
    if (perfBadge) {
      var pct = result.changePct;
      var cls = pct > 0.01 ? 'up' : pct < -0.01 ? 'down' : 'flat';
      var sign = pct > 0 ? '+' : '';
      perfBadge.innerHTML = _totalEquityHTML() + '<span class="portfolio-perf-badge ' + cls + '">' + sign + pct.toFixed(2) + '%</span>' + _marketClosedHTML();
      _applyBubbleGlow(pct);
    }
  });

  // Also update prices on sparkline cards
  if (typeof fetchMarketDataCached === 'function') {
    fetchMarketDataCached(tickers).then(function(marketData) {
      if (!marketData) return;
      holdings.forEach(function(h) {
        if (!marketData[h.ticker]) return;
        var md = marketData[h.ticker];
        var priceEl = document.getElementById('spark-price-' + h.ticker);
        var changeEl = document.getElementById('spark-change-' + h.ticker);
        if (priceEl) priceEl.textContent = '$' + md.price.toFixed(2);
        if (changeEl) {
          var pct = md.changePct;
          var isUp = pct >= 0;
          changeEl.textContent = (isUp ? '+' : '') + pct.toFixed(1) + '% 1D';
          changeEl.className = 'spark-change ' + (isUp ? 'up' : 'down');
        }
      });
    });
  }
}

function loadPortfolioChartRange(range) {
  // Always stop any existing live polling first
  _stopChartLive();
  var chartArea = document.getElementById('portfolioOverviewChartArea');
  var perfBadge = document.getElementById('portfolioOverviewPerf');
  if (!chartArea) return;
  chartArea.classList.add('chart-loading');
  chartArea.innerHTML = '<div class="chart-loading-pulse" style="height:220px;border-radius:8px;"></div>';
  if (perfBadge) perfBadge.innerHTML = '';

  // Update active range button
  var container = document.getElementById('portfolioOverviewChart');
  if (container) {
    container.querySelectorAll('.chart-range-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.range === range);
    });
  }

  // Live mode: immediate tick + start polling every 5s
  if (range === 'live') {
    _chartLiveActive = true;
    _liveChartTick();
    _chartLiveTimer = setInterval(_liveChartTick, _CHART_LIVE_INTERVAL);
    return;
  }

  var tickers = holdings.map(function(h) { return h.ticker; });
  fetchSparklineData(tickers, range).then(function(sparkData) {
    if (!sparkData || Object.keys(sparkData).length === 0) {
      chartArea.classList.remove('chart-loading');
      chartArea.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:220px;color:var(--muted);font-size:12px;">No data available — try again</div>';
      return;
    }
    var result = computePortfolioLine(sparkData, holdings);
    if (!result || result.closes.length < 2) {
      // Retry once after clearing cache for this range
      for (var i = 0; i < tickers.length; i++) {
        var key = tickers[i] + ':' + range;
        if (typeof _sparkCache !== 'undefined') delete _sparkCache[key];
        try { localStorage.removeItem('pc_sp_' + key); } catch(e) {}
      }
      fetchSparklineData(tickers, range).then(function(retryData) {
        chartArea.classList.remove('chart-loading');
        if (!retryData || Object.keys(retryData).length === 0) {
          chartArea.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:220px;color:var(--muted);font-size:12px;">No data available for this range</div>';
          return;
        }
        var retryResult = computePortfolioLine(retryData, holdings);
        if (!retryResult || retryResult.closes.length < 2) {
          chartArea.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:220px;color:var(--muted);font-size:12px;">Insufficient data for this range</div>';
          return;
        }
        chartArea.innerHTML = _renderPortfolioChart(retryResult.closes, 500, 220, retryResult.positive);
        if (perfBadge) {
          var pct = retryResult.changePct;
          var cls = pct > 0.01 ? 'up' : pct < -0.01 ? 'down' : 'flat';
          var sign = pct > 0 ? '+' : '';
          perfBadge.innerHTML = _totalEquityHTML() + '<span class="portfolio-perf-badge ' + cls + '">' + sign + pct.toFixed(2) + '%</span>' + _marketClosedHTML();
          _applyBubbleGlow(pct);
        }
      });
      return;
    }
    chartArea.classList.remove('chart-loading');
    chartArea.innerHTML = _renderPortfolioChart(result.closes, 500, 220, result.positive);

    // Show performance badge
    if (perfBadge) {
      var pct = result.changePct;
      var cls = pct > 0.01 ? 'up' : pct < -0.01 ? 'down' : 'flat';
      var sign = pct > 0 ? '+' : '';
      perfBadge.innerHTML = _totalEquityHTML() + '<span class="portfolio-perf-badge ' + cls + '">' + sign + pct.toFixed(2) + '%</span>' + _marketClosedHTML();
      _applyBubbleGlow(pct);
    }
  });
}

function hidePortfolioOverview() {
  if (typeof _stopChartLive === 'function') _stopChartLive();
  var bubble = document.querySelector('.portfolio-overview');
  if (bubble) bubble.classList.remove('live-glow-up', 'live-glow-down', 'live-glow-flat');
  var container = document.getElementById('portfolioOverviewChart');
  var inputSections = document.getElementById('inputSections');
  if (container) container.style.display = 'none';
  if (inputSections) {
    inputSections.style.display = '';
    var trigger = inputSections.querySelector('.upload-compact-trigger');
    var expanded = inputSections.querySelector('#uploadExpanded');
    var manualLabel = inputSections.querySelector('#manualInputLabel');
    var stockForm = inputSections.querySelector('.stock-form');
    if (trigger) trigger.style.display = '';
    if (expanded) expanded.style.display = '';
    if (manualLabel) manualLabel.style.display = '';
    if (stockForm) stockForm.style.display = '';
  }
}
