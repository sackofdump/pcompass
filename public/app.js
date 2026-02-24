// ── STICKY HEADER COMPACT ON SCROLL ──────────────────────────────────────────
(function() {
  const hdr = document.querySelector('header');
  let compact = false;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const shouldCompact = compact ? y > 20 : y > 80;
    if (shouldCompact !== compact) {
      compact = shouldCompact;
      hdr.classList.toggle('header-compact', compact);
    }
  }, { passive: true });
})();

function escapeHTML(str) {
  if (typeof str !== 'string') return String(str);
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── CLAUDE API HELPER (defined first so all functions can use it) ─────────────
// Sends pro token + email + timestamp so server can verify Pro server-side
async function callClaudeAPI(body) {
  const proToken  = localStorage.getItem('pc_pro_token')  || '';
  const proEmail  = localStorage.getItem('pc_pro_email')  || '';
  const proTs     = localStorage.getItem('pc_pro_ts')     || '';
  const authToken = localStorage.getItem('pc_auth_token') || '';
  const authTs    = localStorage.getItem('pc_auth_ts')    || '';
  return fetch('/api/claude', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pro-Token':  proToken,
      'X-Pro-Email':  proEmail,
      'X-Pro-Ts':     proTs,
      'X-Auth-Token': authToken,
      'X-Auth-Email': proEmail,
      'X-Auth-Ts':    authTs,
    },
    body: JSON.stringify(body),
  });
}


// ── PRO FEATURE CHECK HELPER ─────────────────────────────
// Calls /api/check-feature to verify Pro status server-side
// Returns: 'allowed', 'denied', or 'auth_expired'
async function callCheckFeature(feature) {
  const proToken  = localStorage.getItem('pc_pro_token')  || '';
  const proEmail  = localStorage.getItem('pc_pro_email')  || '';
  const proTs     = localStorage.getItem('pc_pro_ts')     || '';
  const authToken = localStorage.getItem('pc_auth_token') || '';
  const authTs    = localStorage.getItem('pc_auth_ts')    || '';
  try {
    const res = await fetch('/api/check-feature', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pro-Token':  proToken,
        'X-Pro-Email':  proEmail,
        'X-Pro-Ts':     proTs,
        'X-Auth-Token': authToken,
        'X-Auth-Email': proEmail,
        'X-Auth-Ts':    authTs,
      },
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
  const proToken  = localStorage.getItem('pc_pro_token')  || '';
  const proEmail  = localStorage.getItem('pc_pro_email')  || '';
  const proTs     = localStorage.getItem('pc_pro_ts')     || '';
  const authToken = localStorage.getItem('pc_auth_token') || '';
  const authTs    = localStorage.getItem('pc_auth_ts')    || '';
  try {
    const res = await fetch('/api/pro-picks', {
      headers: {
        'X-Pro-Token':  proToken,
        'X-Pro-Email':  proEmail,
        'X-Pro-Ts':     proTs,
        'X-Auth-Token': authToken,
        'X-Auth-Email': proEmail,
        'X-Auth-Ts':    authTs,
      },
    });
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

// ── HOLDINGS LOGIC ───────────────────────────────────────
function totalAllocation() {
  return Math.round(holdings.reduce((s, h) => s + h.pct, 0) * 10) / 10;
}

function addStock() {
  if (!requireAuth()) return;
  const ticker = document.getElementById('tickerInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pct = parseFloat(document.getElementById('pctInput').value);
  const err = document.getElementById('errorMsg');
  err.textContent = '';
  if (!ticker) { err.textContent = 'Enter a ticker symbol.'; return; }
  if (!pct || pct <= 0) { err.textContent = 'Enter a valid percentage.'; return; }
  if (holdings.find(h => h.ticker === ticker)) { err.textContent = ticker + ' already added.'; return; }
  if (totalAllocation() + pct > 100.05) { err.textContent = 'Total exceeds 100%.'; return; }
  const info = STOCK_DB[ticker] || {name:ticker, sector:'Other', beta:1.0, cap:'unknown'};
  holdings.push({ticker, pct, ...info});
  document.getElementById('tickerInput').value = '';
  document.getElementById('pctInput').value = '';
  renderHoldings();
}

function removeStock(ticker) {
  holdings = holdings.filter(h => h.ticker !== ticker);
  renderHoldings();
}

function renderHoldings() {
  const list = document.getElementById('stockList');
  const chip = document.getElementById('summaryChip');
  const btn  = document.getElementById('analyzeBtn');
  const total = totalAllocation();

  list.innerHTML = holdings.map((h, i) => `
    <div class="stock-item">
      <div class="stock-item-top">
        <div class="stock-info">
          <span class="stock-ticker">${escapeHTML(h.ticker)}</span>
          <span class="stock-sector">${escapeHTML(h.sector)}</span>
        </div>
        <button class="btn-remove" onclick="removeStock('${escapeHTML(h.ticker)}')">×</button>
      </div>
      <div class="stock-slider-row">
        <input type="range" class="stock-slider" min="0.1" max="${Math.min(100, h.pct + (100 - total) + h.pct)}" step="0.1"
          value="${h.pct}" oninput="updateSlider(${i}, this.value)" />
        <span class="slider-pct" id="slider-pct-${i}">${h.pct}%</span>
      </div>
    </div>`).join('');

  chip.textContent = total + '% allocated';
  btn.disabled = holdings.length === 0;

  // Hide onboarding only when user has holdings, show it when empty
  const ob = document.getElementById('onboardingBanner');
  if (ob) ob.style.display = holdings.length > 0 ? 'none' : 'block';

  // Show/hide what-if simulator
  const wiPanel = document.getElementById('whatifPanel');
  if (wiPanel) wiPanel.style.display = holdings.length > 0 ? 'block' : 'none';

  updateRiskScore();
  updateCorrelationWarnings();
  updateWhatIfPanel();
  renderPortfolioSlots();

  // Show/hide Clear All button
  const clearBtn = document.getElementById('btnClearAll');
  if (clearBtn) clearBtn.style.display = holdings.length > 0 ? 'block' : 'none';
}

function clearAllHoldings() {
  if (holdings.length === 0) return;
  if (!confirm('Clear all holdings? This will reset your current portfolio.')) return;
  holdings.length = 0;
  document.getElementById('resultsPanel').innerHTML = '<div class="empty-state"><div class="placeholder-icon">📊</div><div class="placeholder-text">Add your US stock holdings<br>on the left, then click<br><strong>Analyze &amp; Recommend</strong></div></div>';
  renderHoldings();
  // Re-enable sticky button visibility for next portfolio
  const stickyBtn = document.querySelector('.btn-analyze-sticky');
  if (stickyBtn) stickyBtn.dataset.analyzed = '';
}

function updateSlider(i, val) {
  const newPct = parseFloat(val);
  const oldPct = holdings[i].pct;
  const otherTotal = totalAllocation() - oldPct;
  if (otherTotal + newPct > 100.05) return;
  holdings[i].pct = Math.round(newPct * 10) / 10;
  document.getElementById('slider-pct-' + i).textContent = holdings[i].pct + '%';
  const chip = document.getElementById('summaryChip');
  if (chip) chip.textContent = totalAllocation() + '% allocated';
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
let lastMarketDataCache = null;

function buildPositionTable(amount, marketData) {
  if (!holdings.length) return '';
  let rows = '';
  holdings.forEach(h => {
    const alloc = h.pct;
    const dollarAmt = (amount * alloc / 100);
    const md = marketData && marketData[h.ticker];
    const price = md ? md.price : null;
    const shares = price ? (dollarAmt / price) : null;
    rows += '<tr>' +
      '<td><span class="ticker-cell">' + escapeHTML(h.ticker) + '</span><br><span class="sector-cell">' + escapeHTML(h.sector || '') + '</span></td>' +
      '<td>' + alloc + '%</td>' +
      '<td class="amount-cell">$' + Math.round(dollarAmt).toLocaleString() + '</td>' +
      '<td class="shares-cell">' + (shares != null ? shares.toFixed(1) : '—') + '</td>' +
      '</tr>';
  });
  return '<table><thead><tr><th>Holdings</th><th>Alloc</th><th>$ Amount</th><th>Est. Shares</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function calcPositionSizing() {
  const input = document.getElementById('positionAmountInput');
  const amount = parseFloat(input?.value) || 0;
  if (amount <= 0) return;
  const tableEl = document.getElementById('positionTableEl');
  if (tableEl) tableEl.innerHTML = buildPositionTable(amount, lastMarketDataCache);
}

// Attach enter key listener after render
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && e.target.id === 'positionAmountInput') calcPositionSizing();
});

// ── ANALYZE ──────────────────────────────────────────────
function scoreETF(etf, profile) {
  let score = 70;
  if (etf.sectors.includes('all')) {
    score += 5;
  } else {
    etf.sectors.forEach(s => {
      if (profile.sectors[s] && profile.sectors[s] > 30) score -= 10;
      if (profile.sectors[s] && profile.sectors[s] < 10) score += 8;
      if (!profile.sectors[s]) score += 12;
    });
  }
  return Math.min(99, Math.max(50, score));
}

function getTopETFs(category, profile, n) {
  const owned = holdings.map(h => h.ticker);
  return ETF_DB[category]
    .filter(e => !owned.includes(e.ticker))
    .map(e => ({...e, score:scoreETF(e, profile)}))
    .sort((a,b) => b.score - a.score)
    .slice(0, n);
}

function matchLabel(score) {
  if (score >= 85) return '<span class="match-score match-high">✦ Great fit</span>';
  return '<span class="match-score match-med">◈ Good fit</span>';
}

function analyze() {
  if (!requireAuth()) return;
  pinnedStrategy = null;
  document.querySelectorAll('.legend-item.hoverable').forEach(e => e.classList.remove('active','active-agg','active-mod','active-con'));
  const profile = getPortfolioProfile();
  const {sectors} = profile;

  const aggressiveETFs = getTopETFs('aggressive', profile, 3);
  const moderateETFs   = getTopETFs('moderate',   profile, 3);
  const conservativeETFs = getTopETFs('conservative', profile, 3);

  // Sector bars
  const heldSectors = Object.entries(sectors).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]);
  const missingSectors = Object.entries(SECTOR_TARGETS)
    .filter(([name, t]) => !(sectors[name] > 0) && (t.agg >= 3 || t.mod >= 3 || t.con >= 3))
    .sort((a,b) => Math.max(b[1].agg,b[1].mod,b[1].con) - Math.max(a[1].agg,a[1].mod,a[1].con))
    .slice(0, 8);

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
    return STOCK_PICKS
      .filter(p => !ownedTickers.includes(p.ticker) && !p.avoidIfHeld.some(t => ownedTickers.includes(t)) && riskAllowed.includes(p.risk))
      .map(p => {
        let score = 50;
        if (!ownedSectors.includes(p.sector)) score += 28;
        else if ((sectors[p.sector]||0) < 10) score += 14;
        if (p.risk === 'Low') score += 6;
        if (p.risk === 'Very High') score -= 8;
        // Boost/penalise with live momentum (±15 pts max)
        const md = marketData && marketData[p.ticker];
        if (md) score += Math.round((md.momentum - 50) * 0.3);
        return {...p, score, isStock:true};
      })
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
    const id = 'item-' + item.ticker + '-' + type;
    if (!item.isStock) {
      return '<div class="etf-item" id="' + id + '" onclick="toggleDrawer(\'' + item.ticker + '\',\'' + type + '\',\'' + safeStr(item.name) + '\',\'' + safeStr(item.desc) + '\',false)">' +
        '<div class="etf-item-header"><div class="ticker-name-group"><div class="ticker-with-tag">' +
        '<span class="etf-ticker">' + item.ticker + '</span><span class="item-type-tag tag-etf">ETF</span></div>' +
        '<div class="etf-details"><h4>' + item.name + ' ' + marketBadgeHTML(item.ticker, marketData) + '</h4><p>' + item.desc + '</p></div></div>' +
        '<div class="etf-meta"><div class="pick-sector-tag">' + (item.sectors[0] === 'all' ? 'Broad Market' : item.sectors[0]) + '</div>' + matchLabel(item.score) + '</div></div>' +
        '<div class="pick-hint">✦ Why this for my portfolio?</div>' +
        '<div class="etf-drawer" id="drawer-' + id + '"><div class="etf-drawer-inner">' +
        '<div class="etf-drawer-label">◈ Why this pick?</div>' +
        '<div class="etf-drawer-text" id="drawer-text-' + id + '"></div></div></div></div>';
    } else {
      return '<div class="etf-item" id="' + id + '" onclick="toggleDrawer(\'' + item.ticker + '\',\'' + type + '\',\'' + safeStr(item.name) + '\',\'' + safeStr(item.desc) + '\',true)">' +
        '<div class="etf-item-header"><div class="ticker-name-group"><div class="ticker-with-tag">' +
        '<span class="pick-ticker">' + item.ticker + '</span><span class="item-type-tag tag-stock">STOCK</span></div>' +
        '<div class="pick-details"><h4>' + item.name + ' ' + marketBadgeHTML(item.ticker, marketData) + '</h4><p>' + item.desc + '</p></div></div>' +
        '<div class="pick-meta"><div class="pick-sector-tag">' + item.sector + '</div>' +
        '<div class="pick-risk" style="color:' + (RISK_COLORS[item.risk]||'#888') + '">' + item.risk + ' Risk</div></div></div>' +
        '<div class="pick-hint">✦ Why this for my portfolio?</div>' +
        '<div class="pick-drawer" id="drawer-' + id + '"><div class="pick-drawer-inner">' +
        '<div class="pick-drawer-label">◈ Why this pick?</div>' +
        '<div class="pick-drawer-text" id="drawer-text-' + id + '"></div></div></div></div>';
    }
  }

  function strategyCard(type, label, desc, etfs, marketData) {
    const picks = getScoredPicks(type, marketData);
    const sortedEtfs = etfs.map(e => ({...e,isStock:false})).sort((a,b) => {
      const ma = marketData && marketData[a.ticker];
      const mb = marketData && marketData[b.ticker];
      const aS = a.score + (ma ? Math.round((ma.momentum - 50) * 0.3) : 0);
      const bS = b.score + (mb ? Math.round((mb.momentum - 50) * 0.3) : 0);
      return bS - aS;
    });

    // All items combined: ETFs first, then stocks
    const allItems = [...sortedEtfs.map(e => ({...e,isStock:false})), ...picks];

    // Primary: first 5 (from truncated free data)
    const primaryItems = allItems.slice(0,5);
    const primaryHTML = primaryItems.map(item => buildItemHTML(item, type, marketData)).join('');

    // Expose buildItemHTML and marketData for dynamic pro pick rendering
    _lastBuildItemHTML = buildItemHTML;
    _lastMarketData = marketData;

    // Empty show-more container — populated dynamically when Pro user clicks "Show more"
    const extraHTML =
      '<div class="show-more-items" id="show-more-' + type + '"></div>' +
      '<button class="btn-show-more" id="show-more-btn-' + type + '" onclick="toggleShowMore(\'' + type + '\')">' +
        '✦ Show more picks' +
      '</button>';

    return '<div class="strategy-card"><div class="strategy-header"><div class="strategy-label">' +
      '<span class="strategy-badge badge-' + type + '">' + label + '</span></div>' +
      '<span class="strategy-desc">' + desc + '</span></div>' +
      '<div class="etf-list">' + primaryHTML + extraHTML + '</div></div>';
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
      ? '<div class="health-alert">&#9888; ' + topSectorName + ' makes up ' + topSectorPct + '% of your portfolio — watch for sector-specific volatility.</div>'
      : '';

    // VS S&P 500 comparisons
    const spyBeta = 1.0;
    const spyTopSector = 28;
    const spyTopHolding = 7;
    const betaDiff = (profile.beta - spyBeta).toFixed(2);
    const sectorDiff = topSectorPct - spyTopSector;
    const holdDiff = (largestHolding ? largestHolding.pct : 0) - spyTopHolding;
    const diffBadge = (val, invert) => {
      const abs = Math.abs(val);
      const cls = (invert ? val <= 0 : val >= 0) ? (abs > 8 ? 'bad' : 'warn') : 'good';
      return '<span class="health-compare-diff ' + cls + '">' + (val > 0 ? '+' : '') + val + (typeof val === 'number' && val % 1 === 0 ? '%' : '') + '</span>';
    };

    const healthHTML =
      '<div class="health-panel">' +
        '<div class="panel-header"><h2 class="section-title">Portfolio Health</h2></div>' +
        alertHTML +
        '<div class="health-cards">' +
          '<div class="health-card">' +
            '<div class="health-card-label">Risk Level</div>' +
            '<div class="health-card-value ' + riskClass + '">' + riskLabel + '</div>' +
            '<div class="health-card-sub">Beta ' + profile.beta.toFixed(2) + '</div>' +
            '<div class="health-card-bar"><div class="health-card-bar-fill" style="width:' + riskBarPct + '%;background:' + riskBarColor + '"></div></div>' +
          '</div>' +
          '<div class="health-card">' +
            '<div class="health-card-label">Diversification</div>' +
            '<div class="health-card-value ' + divClass + '">' + divScore + '<span style="font-size:14px;color:var(--muted)">/100</span></div>' +
            '<div class="health-card-sub">' + divLabel + '</div>' +
            '<div class="health-card-sub" style="margin-top:2px">' + numSectors + ' sectors &middot; top: ' + topSectorPct + '%</div>' +
          '</div>' +
        '</div>' +
        '<div class="health-compare">' +
          '<div class="health-compare-title">vs S&amp;P 500 (SPY)</div>' +
          '<div class="health-compare-row">' +
            '<span class="health-compare-label">Portfolio Beta</span>' +
            '<span class="health-compare-val">' + profile.beta.toFixed(2) + '</span>' +
            '<span class="health-compare-spy">SPY 1.0</span>' +
            diffBadge(betaDiff, true) +
          '</div>' +
          '<div class="health-compare-row">' +
            '<span class="health-compare-label">Top Sector</span>' +
            '<span class="health-compare-val">' + topSectorPct + '%</span>' +
            '<span class="health-compare-spy">SPY ~28%</span>' +
            diffBadge(sectorDiff, true) +
          '</div>' +
          '<div class="health-compare-row">' +
            '<span class="health-compare-label">Largest Holding</span>' +
            '<span class="health-compare-val">' + (largestHolding ? largestHolding.ticker + ' ' + largestHolding.pct + '%' : '—') + '</span>' +
            '<span class="health-compare-spy">SPY top ~7%</span>' +
            diffBadge(holdDiff, true) +
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
          '<div class="panel-header"><h2 class="section-title">Rebalancing Suggestions</h2></div>' +
          '<div class="rebalance-list">' + items + '</div>' +
        '</div>';
    }

    // ── Position Sizing ──
    const positionHTML =
      '<div class="position-panel">' +
        '<div class="panel-header"><h2 class="section-title">Position Sizing</h2></div>' +
        '<div class="position-input-row">' +
          '<label>$</label>' +
          '<input type="number" id="positionAmountInput" value="" min="1" placeholder="Enter your budget">' +
          '<button class="btn-calc" onclick="calcPositionSizing()" title="Calculate">&#8862;</button>' +
        '</div>' +
        '<div class="position-table" id="positionTableEl">' +
        '</div>' +
      '</div>';

    document.getElementById('resultsPanel').innerHTML =
      healthHTML +
      rebalanceHTML +
      '<div class="share-export-row" style="display:flex;gap:8px;margin-bottom:16px;">' +
        '<button class="btn-share" onclick="sharePortfolio()" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;font-family:\'Space Mono\',monospace;font-size:10px;color:var(--muted);cursor:pointer;">🔗 Share Portfolio</button>' +
        '<button class="btn-export-pdf" onclick="exportPDF()" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;font-family:\'Space Mono\',monospace;font-size:10px;color:var(--muted);cursor:pointer;">📄 Download PDF Report</button>' +
      '</div>' +
      '<div class="analysis-bar">' +
        '<div class="analysis-bar-header">' +
          '<h3 class="section-title">Portfolio Breakdown &amp; Strategies</h3>' +
          '<div class="breakdown-legend">' +
            '<div class="legend-item"><div class="legend-dot legend-dot-current"></div>You Own</div>' +
            '<div class="legend-hint">&#8212; hover/click to show</div>' +
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
        '</div>' +
        '<div class="sector-bars" id="sectorBarsEl">' + sectorBars + '</div>' +
      '</div>' +
      '<div class="market-refresh-row">' +
        statusHTML +
        '<button class="btn-refresh-market" id="refreshMarketBtn" onclick="refreshMarketData()">' +
          '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/></svg>' +
          'Refresh' +
        '</button>' +
      '</div>' +
      positionHTML +
      '<div class="panel-header" style="border:none;padding:20px 0 8px;"><h2 class="section-title">Recommended Stocks</h2></div>' +
      strategyCard('aggressive','Aggressive','High growth, high risk', aggressiveETFs, marketData) +
      strategyCard('moderate','Moderate','Growth with stability', moderateETFs, marketData) +
      strategyCard('conservative','Conservative','Capital preservation', conservativeETFs, marketData) +
      '<div class="disclaimer-footer">&#9432; For informational purposes only. Not financial advice. Past performance does not guarantee future results. Always consult a qualified financial advisor before making investment decisions.<br><span style="opacity:0.6">Prices from Polygon.io &middot; Ranked by portfolio fit + live momentum.</span></div>';

    // Re-attach strategy legend listeners
    document.querySelectorAll('.legend-item.hoverable').forEach(el => {
      const s = el.dataset.strategy;
      if (!s) return;
      el.addEventListener('mouseenter', () => showStrategy(s));
      el.addEventListener('mouseleave', () => hideStrategy(s));
      el.addEventListener('click',      () => toggleStrategy(s));
    });
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

  // Scroll to results on mobile
  setTimeout(() => {
    const resultsEl = document.getElementById('resultsPanel');
    if (resultsEl && resultsEl.innerHTML.trim()) {
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Hide sticky analyze button after results show
    const stickyBtn = document.querySelector('.btn-analyze-sticky');
    if (stickyBtn) stickyBtn.classList.remove('visible');
  }, 150);

  // Fetch market data — checks localStorage cache first (1hr TTL) before hitting API
  (async function fetchMarketDataCachedCall() {
    const marketData = await fetchMarketDataCached(tickersToFetch);
    lastMarketFetch = Date.now();
    lastMarketDataCache = marketData;
    renderResultsPanel(marketData);
    updateRefreshBtn();
  })();
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
  const holdingSummary = holdings.map(h => h.ticker + ' (' + h.pct + '% — ' + h.sector + ')').join(', ');
  const profile = getPortfolioProfile();
  const sectorSummary = Object.entries(profile.sectors).sort((a,b) => b[1]-a[1]).map(([s,p]) => s + ': ' + p + '%').join(', ');
  textEl.innerHTML = '<div class="etf-drawer-loading"><div class="mini-spinner"></div> Analyzing your portfolio...</div>';
  try {
    const res = await callClaudeAPI({
      messages:[{role:'user',content:'Portfolio: ' + holdingSummary + '. Sector exposure: ' + sectorSummary + '.\n\nWhy would ' + ticker + ' (' + name + ' — ' + desc + ') be a great ' + (isStock ? 'individual stock pick' : 'ETF') + ' to complement THIS specific portfolio? Reference their actual holdings and what sector gap it fills. Be direct, specific, 2-3 sentences, under 55 words. No bullet points.'}]
    });
    const rawText = await res.text();
    if (res.status === 429) {
      showPaywall('ai');
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
    pct: totalValue > 0 ? Math.round((h.dollarValue / totalValue) * 100 * 10) / 10 : Math.round(100 / allHoldings.length * 10) / 10,
    name: h.name || h.ticker,
    shares: h.shares || 0
  })).sort((a, b) => b.pct - a.pct);

  renderPreview();
  if (errors.length > 0 && allHoldings.length > 0) {
    document.getElementById('importNote').textContent += ' · ' + errors.length + ' screenshot(s) had issues';
  }
}

async function processImageFile(file) {
  if (!requireAuth()) return;
  const base64 = await fileToBase64(file);
  const mediaType = file.type || 'image/png';
  const response = await callClaudeAPI({
    messages:[{role:'user',content:[
      {type:'image',source:{type:'base64',media_type:mediaType,data:base64}},
      {type:'text',text:'This is a screenshot from a stock brokerage app (likely Robinhood). It shows stock holdings with share counts.\n\nRead EVERY ticker and its EXACT share count as shown on screen. Be precise with decimal shares (e.g. 0.811746, 0.098814, 51.58).\n\nRespond ONLY with JSON, no other text:\n{\"holdings\":[{\"ticker\":\"HOOD\",\"shares\":51.58,\"name\":\"Robinhood Markets\"},{\"ticker\":\"QQQ\",\"shares\":1.40,\"name\":\"Invesco QQQ\"}]}\n\nRules:\n- ticker = uppercase symbol exactly as shown\n- shares = exact number shown (keep all decimals)\n- name = company name if you know it, otherwise ticker\n- Skip cash, buying power, or any non-stock items\n- If nothing detected: {\"holdings\":[],\"error\":\"Could not detect holdings\"}'}
    ]}]
  });
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
  const totalPct = previewHoldings.reduce((s,h) => s + h.pct, 0);
  container.innerHTML = previewHoldings.map((h,i) =>
    '<div class="preview-item" style="grid-template-columns:52px 1fr auto 70px 20px;">' +
    '<span class="preview-ticker">' + escapeHTML(h.ticker) + '</span>' +
    '<span class="preview-name">' + escapeHTML(h.name) + '</span>' +
    '<span style="font-family:\'Space Mono\',monospace;font-size:10px;color:var(--muted);white-space:nowrap;">' + (h.shares ? h.shares.toLocaleString(undefined,{maximumFractionDigits:2}) + ' sh' : '') + '</span>' +
    '<div class="preview-pct-wrapper"><input class="preview-pct-input" type="number" value="' + h.pct + '" min="0.1" max="100" step="0.1" onchange="updatePreviewPct(' + i + ',this.value)" /><span class="preview-pct-symbol">%</span></div>' +
    '<button class="btn-preview-remove" onclick="removePreviewItem(' + i + ')">×</button>' +
    '</div>'
  ).join('');
  note.textContent = previewHoldings.length + ' holdings detected · Total: ' + totalPct.toFixed(1) + '% · Adjust if needed';
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
  if (!requireAuth()) return;
  // Clear existing holdings when importing a full portfolio from screenshots
  if (previewHoldings.length >= 3) {
    holdings.length = 0;
  }
  let skipped = [];
  previewHoldings.forEach(h => {
    if (!h.ticker) return;
    if (h.pct <= 0) { h.pct = 0.1; } // give tiny positions a minimum
    if (holdings.find(e => e.ticker === h.ticker)) { skipped.push(h.ticker); return; }
    const info = STOCK_DB[h.ticker] || {name:h.name||h.ticker, sector:'Other', beta:1.0, cap:'unknown'};
    holdings.push({ticker:h.ticker, pct:h.pct, ...info});
  });
  // Normalize to 100% if rounding caused drift
  const total = holdings.reduce((s, h) => s + h.pct, 0);
  if (total > 0 && Math.abs(total - 100) > 0.5) {
    holdings.forEach(h => { h.pct = Math.round((h.pct / total) * 100 * 10) / 10; });
  }
  previewHoldings = [];
  document.getElementById('importPreview').classList.remove('visible');
  renderHoldings();
  if (skipped.length > 0) document.getElementById('errorMsg').textContent = 'Duplicates skipped: ' + skipped.join(', ');
}

// ── THEME TOGGLE ─────────────────────────────────────────
function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  document.getElementById('themeLabel').textContent = isLight ? 'LIGHT' : 'DARK';
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
    result.innerHTML = '<strong style="color:var(--aggressive)">' + ticker + '</strong> is already in your portfolio.'; return;
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
    'Adding <strong>' + ticker + '</strong> (' + info.name + ') at <strong class="wi-new">' + pct + '%</strong>:<br>' +
    '&middot; <strong>' + info.sector + '</strong> exposure &rarr; <strong class="wi-new">' + Math.round((simSectors[info.sector]||0)/simTotal*100) + '%</strong> of portfolio<br>' +
    '&middot; Beta shift <strong class="wi-new">' + betaDir + ' ' + Math.abs(betaDelta) + '</strong> &rarr; new beta: <strong class="wi-new">' + simBeta + '</strong><br>' +
    '&middot; <strong class="wi-new">' + Math.round((100-simTotal)*10)/10 + '%</strong> remaining unallocated';
}

(function() {
  let whatifTimer = null;
  function debouncedWhatIf() { clearTimeout(whatifTimer); whatifTimer = setTimeout(runWhatIf, 300); }
  const wt = document.getElementById('whatifTicker');
  const wp = document.getElementById('whatifPct');
  if (wt) wt.addEventListener('input', debouncedWhatIf);
  if (wp) wp.addEventListener('input', debouncedWhatIf);
})();

// ── PORTFOLIO SAVE/LOAD ───────────────────────────────────
const MAX_SLOTS = 3;
function getSavedPortfolios() { try { return JSON.parse(localStorage.getItem('pc_portfolios') || '[]'); } catch { return []; } }
function savePortfoliosLS(p) { localStorage.setItem('pc_portfolios', JSON.stringify(p)); }

async function savePortfolio() {
  if (!requireAuth()) return;
  if (holdings.length === 0) { showToast('Add holdings first!'); return; }
  const portfolios = getSavedPortfolios();
  if (portfolios.length >= MAX_SLOTS) {
    const result = await callCheckFeature('slots');
    if (result === 'auth_expired') { showToast('Session expired — please sign out and back in.'); return; }
    if (result !== 'allowed') {
      showUpgradeModal();
      return;
    }
  }
  const name = 'Portfolio ' + (portfolios.length + 1);
  portfolios.push({name, holdings: JSON.parse(JSON.stringify(holdings))});
  savePortfoliosLS(portfolios);
  renderPortfolioSlots();
  showToast('✓ Portfolio saved!');
}

function loadPortfolio(idx) {
  const portfolios = getSavedPortfolios();
  if (!portfolios[idx]) return;
  holdings = JSON.parse(JSON.stringify(portfolios[idx].holdings));
  renderHoldings();
  showToast('✓ Portfolio loaded!');
}

function deletePortfolio(idx) {
  const portfolios = getSavedPortfolios();
  const name = portfolios[idx]?.name || 'this portfolio';
  if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
  portfolios.splice(idx, 1);
  savePortfoliosLS(portfolios);
  renderPortfolioSlots();
  showToast('Portfolio deleted.');
}

function renamePortfolio(idx, newName) {
  const portfolios = getSavedPortfolios();
  if (!portfolios[idx]) return;
  portfolios[idx].name = newName || portfolios[idx].name;
  savePortfoliosLS(portfolios);
}

function renderPortfolioSlots() {
  const el = document.getElementById('portfolioSlots');
  if (!el) return;
  const portfolios = getSavedPortfolios();
  if (portfolios.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = portfolios.map((p, i) =>
    '<div class="portfolio-slot" id="slot-' + i + '" onclick="loadPortfolio(' + i + ')">' +
    '<span class="slot-name" id="slot-name-' + i + '">' + escapeHTML(p.name) + '</span>' +
    '<span class="slot-count">' + p.holdings.length + ' holdings</span>' +
    '<div class="slot-actions">' +
    '<button class="slot-btn" onclick="event.stopPropagation();startRenameSlot(' + i + ')" title="Rename">✎</button>' +
    '<button class="slot-btn danger" onclick="event.stopPropagation();deletePortfolio(' + i + ')" title="Delete">&times;</button>' +
    '</div></div>'
  ).join('');
}

function startRenameSlot(i) {
  const nameEl = document.getElementById('slot-name-' + i);
  const slot   = document.getElementById('slot-' + i);
  if (!nameEl) return;
  const current = nameEl.textContent;
  // Replace span with input
  nameEl.outerHTML =
    '<input class="slot-name-input" id="slot-name-' + i + '" value="' + escapeHTML(current) + '" maxlength="24"' +
    ' onclick="event.stopPropagation()"' +
    ' onblur="finishRenameSlot(' + i + ', this.value)"' +
    ' onkeydown="if(event.key===\'Enter\')this.blur();if(event.key===\'Escape\')this.blur();" />';
  const input = document.getElementById('slot-name-' + i);
  if (input) { input.focus(); input.select(); }
}

function finishRenameSlot(i, newName) {
  renamePortfolio(i, newName.trim() || ('Portfolio ' + (i + 1)));
  renderPortfolioSlots();
}


function loadExample(key) {
  if (!requireAuth()) return;
  const example = EXAMPLE_PORTFOLIOS[key];
  if (!example) return;
  holdings = example.map(e => { const info = STOCK_DB[e.ticker] || {name:e.ticker,sector:'Other',beta:1.0,cap:'unknown'}; return {ticker:e.ticker,pct:e.pct,...info}; });
  renderHoldings();
  // onboarding hidden by renderHoldings when holdings exist
}

// ── SHARE PORTFOLIO ───────────────────────────────────────
function sharePortfolio() {
  if (!requireAuth()) return;
  if (holdings.length === 0) { showToast('Add holdings first!'); return; }
  const encoded = holdings.map(h => h.ticker + '-' + h.pct).join('_');
  const url = window.location.origin + window.location.pathname + '?p=' + encoded;
  navigator.clipboard.writeText(url).then(() => showToast('🔗 Link copied!')).catch(() => prompt('Copy this link:', url));
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
    const parsed = p.split('_').map(s => { const [t,pct] = s.split('-'); return {ticker:(t||'').toUpperCase().replace(/[^A-Z0-9.]/g,''), pct:parseFloat(pct)}; }).filter(h=>h.ticker&&h.pct>0).slice(0, 50);
    if (!parsed.length) return;
    holdings = parsed.map(e => { const info = STOCK_DB[e.ticker]||{name:e.ticker,sector:'Other',beta:1.0,cap:'unknown'}; return {ticker:e.ticker,pct:e.pct,...info}; });
    renderHoldings();
    setTimeout(analyze, 400);
  } catch(e) {}
})();

// ── EXPORT PDF ────────────────────────────────────────────
async function exportPDF() {
  if (!requireAuth()) return;
  if (holdings.length === 0) { showToast('Add holdings first!'); return; }

  const result = await callCheckFeature('pdf');
  if (result === 'auth_expired') { showToast('Session expired — please sign out and back in.'); return; }
  if (result !== 'allowed') { showPaywall('pdf'); return; }

  const profile = getPortfolioProfile();
  const {sectors} = profile;
  const riskNum = Math.round(profile.beta * 50 + (profile.concentration || 0) * 0.3);
  const riskLabel = riskNum >= 75 ? 'Aggressive' : riskNum >= 50 ? 'Moderate-High' : riskNum >= 30 ? 'Moderate' : 'Conservative';

  const holdingRows = [...holdings]
    .sort((a, b) => b.pct - a.pct)
    .map(h => `<tr><td style="font-weight:600;color:#00e5a0">${h.ticker}</td><td>${h.name}</td><td>${h.sector}</td><td style="text-align:right;font-weight:600">${h.pct}%</td></tr>`)
    .join('');

  const sectorRows = Object.entries(sectors)
    .filter(([,v]) => v > 0)
    .sort((a,b) => b[1] - a[1])
    .map(([name, pct]) => `<tr><td>${name}</td><td style="text-align:right;font-weight:600">${pct}%</td><td><div style="background:#1e2430;border-radius:3px;height:8px;width:200px;display:inline-block"><div style="background:${SECTOR_COLORS[name]||'#64748b'};height:100%;border-radius:3px;width:${Math.min(100,pct*2.5)}%"></div></div></td></tr>`)
    .join('');

  const date = new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Portfolio Compass Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Space+Mono:wght@400;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0c10; color:#e8ecf0; font-family:'Inter',sans-serif; padding:40px; }
  .header { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e2430; padding-bottom:20px; margin-bottom:30px; }
  .logo { font-family:'Space Mono',monospace; font-size:22px; font-weight:700; }
  .logo span { color:#00e5a0; }
  .date { font-family:'Space Mono',monospace; font-size:11px; color:#8a9ab8; }
  h2 { font-family:'Space Mono',monospace; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#8a9ab8; margin:24px 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td, th { padding:8px 12px; border-bottom:1px solid #1e2430; text-align:left; }
  th { font-family:'Space Mono',monospace; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:#8a9ab8; }
  .card { background:#111318; border:1px solid #1e2430; border-radius:12px; padding:20px; margin-bottom:16px; }
  .health-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:16px; }
  .health-stat { background:#111318; border:1px solid #1e2430; border-radius:10px; padding:16px; text-align:center; }
  .health-stat .value { font-family:'Space Mono',monospace; font-size:24px; font-weight:700; color:#00e5a0; }
  .health-stat .label { font-family:'Space Mono',monospace; font-size:9px; color:#8a9ab8; letter-spacing:1px; text-transform:uppercase; margin-top:4px; }
  .risk-bar { height:8px; background:#1e2430; border-radius:4px; margin:8px 0; }
  .risk-fill { height:100%; border-radius:4px; }
  .footer { text-align:center; font-family:'Space Mono',monospace; font-size:9px; color:#5a647880; margin-top:40px; padding-top:20px; border-top:1px solid #1e2430; }
  @media print { body { padding:20px; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; } }
</style></head><body>
<div class="header">
  <div class="logo">🧭 Portfolio <span>Compass</span></div>
  <div class="date">${date}</div>
</div>

<div class="health-grid">
  <div class="health-stat">
    <div class="value">${holdings.length}</div>
    <div class="label">Holdings</div>
  </div>
  <div class="health-stat">
    <div class="value">${Object.keys(sectors).filter(s => sectors[s] > 0).length}</div>
    <div class="label">Sectors</div>
  </div>
  <div class="health-stat">
    <div class="value" style="color:${riskNum >= 65 ? '#ff4d6d' : riskNum >= 40 ? '#ffd166' : '#06d6a0'}">${riskLabel}</div>
    <div class="label">Risk Level</div>
  </div>
</div>

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
    <span style="font-family:'Space Mono',monospace;font-size:10px;color:#8a9ab8;letter-spacing:1px;text-transform:uppercase;">Portfolio Risk</span>
    <span style="font-family:'Space Mono',monospace;font-size:14px;font-weight:700;color:${riskNum >= 65 ? '#ff4d6d' : riskNum >= 40 ? '#ffd166' : '#06d6a0'}">${riskNum}/100</span>
  </div>
  <div class="risk-bar"><div class="risk-fill" style="width:${riskNum}%;background:linear-gradient(90deg,#06d6a0,#ffd166,#ff4d6d)"></div></div>
</div>

<h2>Holdings</h2>
<div class="card">
  <table>
    <tr><th>Ticker</th><th>Name</th><th>Sector</th><th style="text-align:right">Weight</th></tr>
    ${holdingRows}
  </table>
</div>

<h2>Sector Exposure</h2>
<div class="card">
  <table>
    <tr><th>Sector</th><th style="text-align:right">Weight</th><th>Distribution</th></tr>
    ${sectorRows}
  </table>
</div>

<div class="footer">
  Generated by Portfolio Compass · pcompass.vercel.app · For informational purposes only — not financial advice.
</div>
</body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  setTimeout(() => { win.print(); }, 500);
  showToast('📄 PDF report opened!');
}

// ── ONBOARDING INIT ───────────────────────────────────────
(function initOnboarding() {
  const banner = document.getElementById('onboardingBanner');
  if (!banner) return;
  if (holdings.length > 0) banner.style.display = 'none';
})();

renderPortfolioSlots();

// ── SHOW MORE TOGGLE ─────────────────────────────────────
async function toggleShowMore(type) {
  const panel = document.getElementById('show-more-' + type);
  const btn   = document.getElementById('show-more-btn-' + type);
  if (!panel || !btn) return;

  // If already open, just close
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    btn.classList.remove('open');
    btn.innerHTML = '✦ Show more picks';
    const panel2 = document.getElementById('show-more-2-' + type);
    const btn2   = document.getElementById('show-more-btn-2-' + type);
    if (panel2) panel2.classList.remove('open');
    if (btn2) { btn2.classList.remove('open'); btn2.innerHTML = '✦ Show more picks'; }
    return;
  }

  // First expansion: verify Pro server-side
  const result = await callCheckFeature('picks');
  if (result === 'auth_expired') { showToast('Session expired — please sign out and back in.'); return; }
  if (result !== 'allowed') { showPaywall('showmore'); return; }

  // If panel is still empty, fetch pro picks and render them
  if (panel.querySelectorAll(':scope > .etf-item').length === 0) {
    btn.innerHTML = '<span class="mini-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid var(--muted);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;margin-right:6px;vertical-align:middle;"></span> Loading...';
    const proData = await fetchProPicks();
    if (!proData) {
      btn.innerHTML = '✦ Show more picks';
      showToast('Failed to load extra picks. Try again.');
      return;
    }
    // Render extra items into the container
    const extraHTML = _renderProPicksForStrategy(type, proData);
    if (extraHTML) {
      panel.insertAdjacentHTML('afterbegin', extraHTML);
    }
  }

  panel.classList.add('open');
  btn.classList.add('open');
  btn.innerHTML = '▾ Show fewer picks';
}

function toggleShowMore2(type) {
  const panel = document.getElementById('show-more-2-' + type);
  const btn   = document.getElementById('show-more-btn-2-' + type);
  if (!panel || !btn) return;
  const open = panel.classList.toggle('open');
  btn.classList.toggle('open', open);
  btn.innerHTML = open
    ? '▾ Show fewer picks'
    : '✦ Show ' + panel.querySelectorAll('.etf-item').length + ' more picks';
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
    .slice(0,5);

  // Score and filter pro ETFs for this strategy
  const proEtfs = (proData.etfs && proData.etfs[type]) || [];
  const etfs = proEtfs
    .filter(e => !ownedTickers.includes(e.ticker))
    .map(e => ({...e, score:70, isStock:false}));

  const allExtra = [...etfs, ...picks];
  if (allExtra.length === 0) return '';

  return allExtra.map(item => _lastBuildItemHTML(item, type, _lastMarketData)).join('');
}

// ── UPGRADE MODAL ────────────────────────────────────────
function showPaywall(trigger) {
  const msgs = {
    ai:       'You\'ve used your 3 free AI explanations.',
    pdf:      'PDF export is a Pro feature.',
    sync:     'Cloud sync is a Pro feature.',
    showmore: 'Expanded picks are a Pro feature.',
    header:   'Upgrade to unlock all Pro features.',
    screenshot:'Screenshot import is a Pro feature.',
  };
  const msgEl = document.getElementById('paywallMsg');
  if (msgEl) msgEl.textContent = 'You must have Pro Access to access this.';
  const modal = document.getElementById('paywallModal');

  // Inside iOS app: hide Stripe buttons, show website redirect (Apple Guideline 3.1.1)
  if (typeof _isIOSApp !== 'undefined' && _isIOSApp) {
    const tiers = modal.querySelectorAll('[id^="tier-"]');
    tiers.forEach(function(el) { el.style.display = 'none'; });
    const confirmBtn = document.getElementById('paywallConfirmBtn');
    if (confirmBtn) {
      confirmBtn.textContent = 'Visit pcompass.vercel.app to upgrade';
      confirmBtn.onclick = function() { closePaywall(); showToast('Visit pcompass.vercel.app in your browser to upgrade.'); };
    }
  }

  modal.style.display = 'flex';
  modal.classList.add('open');
}
function showUpgradeModal() { showPaywall('ai'); }
function closePaywall() {
  const pm2=document.getElementById('paywallModal');pm2.style.display='none';pm2.classList.remove('open');
}
function closeUpgradeModal() {
  document.getElementById('upgradeModal').classList.remove('open');
}
// Close on backdrop click
document.addEventListener('click', e => {
  const modal = document.getElementById('upgradeModal');
  if (modal && e.target === modal) closeUpgradeModal();
});

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
      '<div class="autocomplete-item" data-ticker="' + ticker + '" onclick="selectAutocomplete(\'' + ticker + '\')">' +
      '<span class="autocomplete-item-ticker">' + ticker + '</span>' +
      '<span class="autocomplete-item-name">' + info.name + '</span>' +
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
