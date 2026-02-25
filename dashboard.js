// Sapinover Overnight Trading Analysis Dashboard v3.0
// Built for institutional-grade market microstructure research

// ============================================================================
// GLOBAL STATE
// ============================================================================

let DATA = null;
let FILTERED_DATA = [];
let LOOKUP = null;
let META = null;

// View states
let CURRENT_TAB = 'summary';
let USE_WINSORIZED = true;
let SELECTED_DATE = null;

// Explorer state
let EXPLORER_PAGE = 1;
let EXPLORER_SORT = { column: 'notional', ascending: false };
let EXPLORER_FILTERS = { symbol: '', sector: 'all', assetType: 'all', gapDirection: 'all' };
const ROWS_PER_PAGE = 50;

// Chart instances (for cleanup)
let chartInstances = {};

// Analytics tab states
let CLUSTER_STATE = { k: 4, features: ['capturedAlpha', 'refGap', 'notional'], results: null };
let SCREENER_STATE = {
    filters: { minObs: 3, minNotional: 0, sector: 'all', assetType: 'all' },
    sort: { column: 'avgCapturedAlpha', ascending: false },
    page: 1,
    watchlist: new Set()
};
let REGIME_STATE = { window: 10 };
let RISK_STATE = { confidenceLevel: 95 };

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async function() {
    // Setup tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Load data
    await loadData();
});

async function loadData() {
    const progressBar = document.getElementById('loadingBar');
    try {
        if (progressBar) progressBar.style.width = '10%';
        const response = await fetch('data.json');
        if (!response.ok) throw new Error('Failed to load data.json');
        if (progressBar) progressBar.style.width = '35%';

        const json = await response.json();
        if (progressBar) progressBar.style.width = '60%';
        
        META = json.meta;
        LOOKUP = json.lookup;
        
        // Process raw data into usable objects
        DATA = json.data.map(row => ({
            symbol: LOOKUP.symbols[row[0]],
            company: LOOKUP.companies[row[1]],
            date: LOOKUP.dates[row[2]],
            assetType: row[3] === 1 ? 'ETF' : 'Stock',
            sector: LOOKUP.sectors[row[4]],
            notional: row[5],
            volume: row[6],
            executions: row[7],
            vwap: row[8],
            priorClose: row[9],
            nextOpen: row[10],
            nextClose: row[11],
            timingDiff: row[12],
            timingDiffW: row[13],
            refGap: row[14],
            refGapW: row[15],
            totalGap: row[16],
            gapDirection: row[17] === 1 ? 'UP' : 'DOWN',
            dirConsistency: row[18] === 1,
            isOutlier: row[19] === 1,
            marketCap: row[20],
            leverageMult: row[21],
            capturedAlpha: row[22],
            capturedAlphaW: row[23]
        }));
        
        if (progressBar) progressBar.style.width = '80%';
        FILTERED_DATA = [...DATA];
        SELECTED_DATE = LOOKUP.dates[LOOKUP.dates.length - 1]; // Most recent

        // Update header
        document.getElementById('dateRangeDisplay').textContent = 
            `${META.dateRange[0]} to ${META.dateRange[1]} (${META.tradingDays} days)`;
        document.getElementById('generatedDisplay').textContent = 
            `Generated: ${META.generated}`;
        document.getElementById('footerYear').textContent = 
            new Date().getFullYear();
        
        // Build the dashboard
        buildDashboard();
        if (progressBar) {
            progressBar.style.width = '100%';
            setTimeout(() => { progressBar.style.opacity = '0'; }, 500);
            setTimeout(() => { progressBar.style.display = 'none'; }, 900);
        }

    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('mainContent').innerHTML = `
            <div class="card" style="text-align: center; padding: 3rem;">
                <h3 style="color: var(--danger); margin-bottom: 1rem;">Error Loading Data</h3>
                <p style="color: var(--text-secondary);">
                    Could not load data.json. Make sure the file is in the same directory as index.html.
                </p>
                <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 1rem;">
                    Error: ${error.message}
                </p>
            </div>
        `;
    }
}

function buildDashboard() {
    const main = document.getElementById('mainContent');
    main.innerHTML = `
        <!-- Filter Panel -->
        <div class="filter-panel">
            <div class="filter-group">
                <label>Asset Type</label>
                <select id="filterAssetType" onchange="applyFilters()">
                    <option value="all">All Types</option>
                    <option value="Stock">Stocks Only</option>
                    <option value="ETF">ETFs Only</option>
                </select>
            </div>
            <div class="filter-group">
                <label>Sector</label>
                <select id="filterSector" onchange="applyFilters()">
                    <option value="all">All Sectors</option>
                </select>
            </div>
            <div class="filter-group">
                <label>Min Notional ($K)</label>
                <input type="number" id="filterNotional" value="0" min="0" step="100" onchange="applyFilters()">
            </div>
            <div class="filter-group">
                <label>Data View</label>
                <div class="toggle-group">
                    <button class="toggle-btn active" id="btnWinsorized" onclick="setWinsorized(true)">Winsorized</button>
                    <button class="toggle-btn" id="btnFullRange" onclick="setWinsorized(false)">Full Range</button>
                </div>
            </div>
        </div>
        
        <!-- Tab Contents -->
        <div class="tab-content active" id="tab-summary"></div>
        <div class="tab-content" id="tab-daily"></div>
        <div class="tab-content" id="tab-structure"></div>
        <div class="tab-content" id="tab-quadrant"></div>
        <div class="tab-content" id="tab-explorer"></div>
        <div class="tab-content" id="tab-clustering"></div>
        <div class="tab-content" id="tab-correlation"></div>
        <div class="tab-content" id="tab-risk"></div>
        <div class="tab-content" id="tab-timeseries"></div>
        <div class="tab-content" id="tab-screener"></div>
        <div class="tab-content" id="tab-asiasleeps"></div>
        <div class="tab-content" id="tab-methodology"></div>
    `;
    
    // Populate sector filter
    populateSectorFilter();
    
    // Render initial tab
    renderCurrentTab();
}

function populateSectorFilter() {
    const sectors = [...new Set(FILTERED_DATA.map(d => d.sector))].sort();
    const select = document.getElementById('filterSector');
    
    sectors.forEach(s => {
        if (s && s !== 'Unknown') {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s.length > 30 ? s.substring(0, 30) + '...' : s;
            select.appendChild(opt);
        }
    });
}

// ============================================================================
// FILTERING & VIEW CONTROLS
// ============================================================================

function applyFilters() {
    const assetType = document.getElementById('filterAssetType').value;
    const sector = document.getElementById('filterSector').value;
    const minNotional = parseFloat(document.getElementById('filterNotional').value) * 1000 || 0;
    
    FILTERED_DATA = DATA.filter(d => {
        if (assetType !== 'all' && d.assetType !== assetType) return false;
        if (sector !== 'all' && d.sector !== sector) return false;
        if (d.notional < minNotional) return false;
        return true;
    });
    
    EXPLORER_PAGE = 1;
    renderCurrentTab();
}

function setWinsorized(winsorized) {
    USE_WINSORIZED = winsorized;
    document.getElementById('btnWinsorized').classList.toggle('active', winsorized);
    document.getElementById('btnFullRange').classList.toggle('active', !winsorized);
    renderCurrentTab();
}

function switchTab(tabId) {
    CURRENT_TAB = tabId;
    
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tabId}`);
    });
    
    renderCurrentTab();
}

function renderCurrentTab() {
    // Destroy old charts
    Object.values(chartInstances).forEach(chart => {
        if (chart && chart.destroy) chart.destroy();
    });
    chartInstances = {};
    
    const tabRenderers = {
        summary: renderSummaryTab,
        daily: renderDailyTab,
        structure: renderStructureTab,
        quadrant: renderQuadrantTab,
        explorer: renderExplorerTab,
        clustering: renderClusteringTab,
        correlation: renderCorrelationTab,
        risk: renderRiskTab,
        timeseries: renderTimeSeriesTab,
        screener: renderScreenerTab,
        asiasleeps: renderAsiaSleepsTab,
        methodology: renderMethodologyTab
    };
    const renderer = tabRenderers[CURRENT_TAB];
    if (renderer) {
        try {
            renderer();
        } catch (e) {
            console.error(`Error rendering ${CURRENT_TAB} tab:`, e);
            const container = document.getElementById(`tab-${CURRENT_TAB}`);
            if (container) container.innerHTML = `<div class="card" style="padding:2rem;color:#f87171;"><h3>Error rendering tab</h3><pre style="margin-top:1rem;font-size:0.8rem;color:#9ca3b4;white-space:pre-wrap;">${e.message}\n${e.stack}</pre></div>`;
        }
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatNumber(num, decimals = 0) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    return num.toLocaleString('en-US', { 
        minimumFractionDigits: decimals, 
        maximumFractionDigits: decimals 
    });
}

function formatCurrency(num, compact = false) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    
    if (compact) {
        if (Math.abs(num) >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
        if (Math.abs(num) >= 1e6) return '$' + (num / 1e6).toFixed(1) + 'M';
        if (Math.abs(num) >= 1e3) return '$' + (num / 1e3).toFixed(0) + 'K';
    }
    return '$' + formatNumber(num);
}

function formatBps(num, showSign = false) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    const sign = showSign && num > 0 ? '+' : '';
    return sign + num.toFixed(1) + ' bps';
}

function formatPercent(num, decimals = 1) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    return num.toFixed(decimals) + '%';
}

function getTimingDiff(d) {
    return USE_WINSORIZED ? d.timingDiffW : d.timingDiff;
}

function getRefGap(d) {
    return USE_WINSORIZED ? d.refGapW : d.refGap;
}

function getCapturedAlpha(d) {
    return USE_WINSORIZED ? d.capturedAlphaW : d.capturedAlpha;
}

function getQuadrant(d) {
    const td = getTimingDiff(d);
    const rg = getRefGap(d);
    
    if (rg >= 0 && td >= 0) return 'Q1';
    if (rg < 0 && td >= 0) return 'Q2';
    if (rg < 0 && td < 0) return 'Q3';
    return 'Q4';
}

function getQuadrantInfo(q) {
    const info = {
        'Q1': { name: 'Momentum', color: '#34d399', desc: 'Positive gap, positive timing' },
        'Q2': { name: 'Mean Reversion', color: '#fbbf24', desc: 'Negative gap, positive timing' },
        'Q3': { name: 'Protection', color: '#f87171', desc: 'Negative gap, negative timing' },
        'Q4': { name: 'Top Tick', color: '#a78bfa', desc: 'Positive gap, negative timing' }
    };
    return info[q] || { name: 'Unknown', color: '#666', desc: '' };
}

function getValueClass(value) {
    if (value === null || value === undefined) return '';
    return value >= 0 ? 'positive' : 'negative';
}

// ============================================================================
// TAB 1: EXECUTIVE SUMMARY
// ============================================================================

function renderSummaryTab() {
    const container = document.getElementById('tab-summary');
    
    // Calculate summary stats
    const totalNotional = FILTERED_DATA.reduce((sum, d) => sum + d.notional, 0);
    const totalVolume = FILTERED_DATA.reduce((sum, d) => sum + d.volume, 0);
    const avgTimingDiff = FILTERED_DATA.reduce((sum, d) => sum + getTimingDiff(d), 0) / FILTERED_DATA.length;
    const avgRefGap = FILTERED_DATA.reduce((sum, d) => sum + getRefGap(d), 0) / FILTERED_DATA.length;
    const avgCapturedAlpha = FILTERED_DATA.reduce((sum, d) => sum + getCapturedAlpha(d), 0) / FILTERED_DATA.length;
    const dirConsistencyRate = FILTERED_DATA.filter(d => d.dirConsistency).length / FILTERED_DATA.length * 100;
    const uniqueSymbols = new Set(FILTERED_DATA.map(d => d.symbol)).size;
    const dailyAvgNotional = totalNotional / META.tradingDays;
    
    container.innerHTML = `
        <!-- Hero Section -->
        <div class="hero">
            <h2>Overnight ATS <span>Market Microstructure</span> Analysis</h2>
            <p class="hero-subtitle">
                Quantitative analysis of ${formatNumber(FILTERED_DATA.length)} overnight equity trading observations 
                across ${META.tradingDays} sessions, representing ${formatCurrency(totalNotional, true)} in institutional flow.
            </p>
            <div class="hero-stats">
                <div class="hero-stat">
                    <div class="hero-stat-value">${formatCurrency(totalNotional, true)}</div>
                    <div class="hero-stat-label">Total Notional</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-value">${formatNumber(FILTERED_DATA.length)}</div>
                    <div class="hero-stat-label">Observations</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-value">${uniqueSymbols}</div>
                    <div class="hero-stat-label">Unique Symbols</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-value">${formatPercent(dirConsistencyRate)}</div>
                    <div class="hero-stat-label">Price Continuity</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-value">${formatCurrency(dailyAvgNotional, true)}</div>
                    <div class="hero-stat-label">Daily Average</div>
                </div>
            </div>
        </div>
        
        <!-- Daily Flow Charts -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Daily Trading Flow</h3>
                <span class="section-subtitle">Notional volume and share activity by session</span>
            </div>
            <div class="chart-grid">
                <div class="card">
                    <h4 class="card-title">Daily Notional & Volume</h4>
                    <div class="chart-container" id="summaryDailyChart"></div>
                </div>
                <div class="card">
                    <h4 class="card-title">Price Continuity Rate</h4>
                    <div class="chart-container" id="summaryConsistencyChart"></div>
                </div>
            </div>
        </section>
        
        <!-- Key Metrics -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Performance Metrics</h3>
            </div>
            <div class="metrics-grid">
                <div class="metric-card">
                    <div class="metric-value ${getValueClass(avgCapturedAlpha)}">${formatBps(avgCapturedAlpha, true)}</div>
                    <div class="metric-label">Avg Captured Alpha</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value ${getValueClass(avgRefGap)}">${formatBps(avgRefGap, true)}</div>
                    <div class="metric-label">Avg Reference Gap</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value ${getValueClass(avgTimingDiff)}">${formatBps(avgTimingDiff, true)}</div>
                    <div class="metric-label">Avg Timing Differential</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${formatNumber(FILTERED_DATA.reduce((sum, d) => sum + d.executions, 0))}</div>
                    <div class="metric-label">Total Executions</div>
                </div>
            </div>
        </section>
        
        <!-- Asset Breakdown -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Asset Class Breakdown</h3>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Asset Type</th>
                            <th>Observations</th>
                            <th>Notional</th>
                            <th>% of Total</th>
                            <th>Avg Captured Alpha</th>
                            <th>Continuity Rate</th>
                        </tr>
                    </thead>
                    <tbody id="summaryAssetTable"></tbody>
                </table>
            </div>
        </section>
        
        <!-- Position Size Tiers -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Position Size Analysis</h3>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Size Tier</th>
                            <th>Observations</th>
                            <th>Notional</th>
                            <th>% of Total</th>
                            <th>Avg Size</th>
                            <th>Continuity Rate</th>
                        </tr>
                    </thead>
                    <tbody id="summarySizeTable"></tbody>
                </table>
            </div>
            <div class="highlight-box">
                <h4>Institutional Flow Concentration</h4>
                <p id="summaryHighlight"></p>
            </div>
        </section>
        
        <!-- Disclaimer -->
        <div class="disclaimer">
            <div class="disclaimer-title">Disclaimer</div>
            <p>
                This analysis is provided for informational purposes only and represents independent market
                microstructure research prepared by Sapinover LLC. Past trading activity is not indicative of future
                liquidity or execution quality. This material does not constitute investment advice, trading
                recommendations, or solicitation to buy or sell securities. "Price Continuity" measures the rate at which
                overnight execution prices fall between the prior close and next-day open in the direction of the overnight gap.
            </p>
        </div>
    `;
    
    renderSummaryCharts();
    renderSummaryTables();
}

function renderSummaryCharts() {
    // Aggregate by date
    const dailyStats = {};
    LOOKUP.dates.forEach(d => {
        dailyStats[d] = { notional: 0, volume: 0, count: 0, consistent: 0 };
    });
    
    FILTERED_DATA.forEach(d => {
        dailyStats[d.date].notional += d.notional;
        dailyStats[d.date].volume += d.volume;
        dailyStats[d.date].count++;
        if (d.dirConsistency) dailyStats[d.date].consistent++;
    });
    
    const dates = LOOKUP.dates;
    const labels = dates.map(d => d.substring(5)); // MM-DD format
    const notionalData = dates.map(d => dailyStats[d].notional / 1e9);
    const volumeData = dates.map(d => dailyStats[d].volume / 1e6 / 25); // Scaled for visual
    const consistencyData = dates.map(d => 
        dailyStats[d].count > 0 ? (dailyStats[d].consistent / dailyStats[d].count) * 100 : 0
    );
    
    // Daily Notional & Volume Chart
    const ctx1 = document.createElement('canvas');
    document.getElementById('summaryDailyChart').appendChild(ctx1);
    
    chartInstances.dailyChart = new Chart(ctx1, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Notional ($B)',
                    data: notionalData,
                    backgroundColor: 'rgba(201, 162, 39, 0.85)',
                    borderColor: 'rgba(201, 162, 39, 1)',
                    borderWidth: 1,
                    borderRadius: 3,
                    order: 2
                },
                {
                    label: 'Volume (M÷25)',
                    data: volumeData,
                    backgroundColor: 'rgba(79, 139, 249, 0.7)',
                    borderColor: 'rgba(79, 139, 249, 1)',
                    borderWidth: 1,
                    borderRadius: 3,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: { color: '#9ca3b4', boxWidth: 12, padding: 15 }
                }
            },
            scales: {
                y: {
                    stacked: true,
                    beginAtZero: true,
                    grid: { color: 'rgba(156, 163, 180, 0.1)' },
                    ticks: { color: '#6b7280' },
                    title: { display: true, text: 'Notional ($B) + Scaled Volume', color: '#6b7280' }
                },
                x: {
                    stacked: true,
                    grid: { display: false },
                    ticks: { color: '#6b7280', maxRotation: 45, font: { size: 10 } }
                }
            }
        }
    });
    
    // Price Continuity Chart
    const ctx2 = document.createElement('canvas');
    document.getElementById('summaryConsistencyChart').appendChild(ctx2);
    
    // Calculate 5-day moving average
    const ma5 = consistencyData.map((val, idx) => {
        if (idx < 4) return null;
        const sum = consistencyData.slice(idx - 4, idx + 1).reduce((a, b) => a + b, 0);
        return sum / 5;
    });
    
    chartInstances.consistencyChart = new Chart(ctx2, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Daily Rate',
                    data: consistencyData,
                    borderColor: '#34d399',
                    backgroundColor: 'rgba(52, 211, 153, 0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                    pointBackgroundColor: '#34d399'
                },
                {
                    label: '5-Day MA',
                    data: ma5,
                    borderColor: '#c9a227',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: { color: '#9ca3b4', boxWidth: 12, padding: 15 }
                }
            },
            scales: {
                y: {
                    min: 50,
                    max: 100,
                    grid: { color: 'rgba(156, 163, 180, 0.1)' },
                    ticks: { color: '#6b7280', callback: v => v + '%' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#6b7280', maxRotation: 45, font: { size: 10 } }
                }
            }
        }
    });
}

function renderSummaryTables() {
    const totalNotional = FILTERED_DATA.reduce((sum, d) => sum + d.notional, 0);
    
    // Asset Type Breakdown
    const assetStats = {};
    FILTERED_DATA.forEach(d => {
        if (!assetStats[d.assetType]) {
            assetStats[d.assetType] = { count: 0, notional: 0, capturedSum: 0, consistent: 0 };
        }
        assetStats[d.assetType].count++;
        assetStats[d.assetType].notional += d.notional;
        assetStats[d.assetType].capturedSum += getCapturedAlpha(d);
        if (d.dirConsistency) assetStats[d.assetType].consistent++;
    });

    const assetTableBody = document.getElementById('summaryAssetTable');
    assetTableBody.innerHTML = Object.entries(assetStats)
        .sort((a, b) => b[1].notional - a[1].notional)
        .map(([type, stats]) => {
            const avgTiming = stats.capturedSum / stats.count;
            const contRate = (stats.consistent / stats.count) * 100;
            return `
                <tr>
                    <td style="font-weight: 600;">${type}</td>
                    <td>${formatNumber(stats.count)}</td>
                    <td class="mono">${formatCurrency(stats.notional, true)}</td>
                    <td>${formatPercent(stats.notional / totalNotional * 100)}</td>
                    <td class="${getValueClass(avgTiming)} mono">${formatBps(avgTiming, true)}</td>
                    <td class="positive">${formatPercent(contRate)}</td>
                </tr>
            `;
        }).join('');
    
    // Position Size Tiers
    const sizeTiers = [
        { label: '≥ $10M', min: 10e6 },
        { label: '≥ $5M', min: 5e6 },
        { label: '≥ $1M', min: 1e6 },
        { label: '≥ $500K', min: 500e3 },
        { label: '≥ $100K', min: 100e3 },
        { label: '< $100K', min: 0 }
    ];
    
    const sizeTableBody = document.getElementById('summarySizeTable');
    let prevMin = Infinity;
    
    sizeTableBody.innerHTML = sizeTiers.map(tier => {
        const tierData = FILTERED_DATA.filter(d => d.notional >= tier.min && d.notional < prevMin);
        prevMin = tier.min;
        
        const tierNotional = tierData.reduce((sum, d) => sum + d.notional, 0);
        const tierConsistent = tierData.filter(d => d.dirConsistency).length;
        const avgSize = tierData.length > 0 ? tierNotional / tierData.length : 0;
        const contRate = tierData.length > 0 ? (tierConsistent / tierData.length) * 100 : 0;
        
        return `
            <tr>
                <td style="font-weight: 600;">${tier.label}</td>
                <td>${formatNumber(tierData.length)}</td>
                <td class="mono">${formatCurrency(tierNotional, true)}</td>
                <td>${formatPercent(tierNotional / totalNotional * 100)}</td>
                <td class="mono">${formatCurrency(avgSize, true)}</td>
                <td class="positive">${formatPercent(contRate)}</td>
            </tr>
        `;
    }).join('');
    
    // Highlight box
    const over1M = FILTERED_DATA.filter(d => d.notional >= 1e6);
    const over1MNotional = over1M.reduce((sum, d) => sum + d.notional, 0);
    const avgBlockSize = over1M.length > 0 ? over1MNotional / over1M.length : 0;
    
    document.getElementById('summaryHighlight').textContent = 
        `${formatPercent(over1MNotional / totalNotional * 100)} of notional derives from ${formatNumber(over1M.length)} ` +
        `observations ≥$1M with average block size of ${formatCurrency(avgBlockSize, true)}. ` +
        `Institutional-grade flow dominates overnight ATS activity.`;
}

// ============================================================================
// TAB 2: DAILY ANALYSIS
// ============================================================================

function renderDailyTab() {
    const container = document.getElementById('tab-daily');
    
    container.innerHTML = `
        <div class="date-selector">
            <label>Select Trading Date:</label>
            <select id="dailyDateSelect" onchange="updateDailyDate(this.value)">
                ${LOOKUP.dates.slice().reverse().map(d => 
                    `<option value="${d}" ${d === SELECTED_DATE ? 'selected' : ''}>${d}</option>`
                ).join('')}
            </select>
        </div>
        
        <!-- Daily Stats -->
        <div class="metrics-grid" id="dailyMetrics"></div>
        
        <!-- Daily Charts -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Daily Trends</h3>
                <span class="section-subtitle">Timing differential and notional with 5-day moving average</span>
            </div>
            <div class="chart-grid">
                <div class="card">
                    <h4 class="card-title">Captured Alpha Trend</h4>
                    <div class="chart-container" id="dailyTimingChart"></div>
                </div>
                <div class="card">
                    <h4 class="card-title">Daily Notional Volume</h4>
                    <div class="chart-container" id="dailyNotionalChart"></div>
                </div>
            </div>
        </section>
        
        <!-- Sector Breakdown for Selected Date -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Sector Performance</h3>
                <span class="section-subtitle" id="dailySectorSubtitle">--</span>
            </div>
            <div class="chart-grid">
                <div class="card">
                    <h4 class="card-title">Sector Notional Distribution</h4>
                    <div class="chart-container" id="dailySectorChart"></div>
                </div>
                <div class="card">
                    <h4 class="card-title">Captured Alpha Distribution</h4>
                    <div class="chart-container" id="dailyHistogram"></div>
                </div>
            </div>
        </section>
        
        <!-- Top Positions Table -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Top Positions</h3>
                <span class="section-subtitle" id="dailyTableSubtitle">--</span>
            </div>
            <div class="table-container">
                <div class="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th class="sortable" onclick="sortDailyTable('symbol')">Symbol</th>
                                <th>Company</th>
                                <th>Type</th>
                                <th>Sector</th>
                                <th class="sortable" onclick="sortDailyTable('notional')">Notional</th>
                                <th class="sortable" onclick="sortDailyTable('capturedAlpha')">Captured Alpha</th>
                                <th class="sortable" onclick="sortDailyTable('refGap')">Ref Gap</th>
                                <th>Gap Dir</th>
                                <th>Continuity</th>
                            </tr>
                        </thead>
                        <tbody id="dailyTableBody"></tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
    
    updateDailyDate(SELECTED_DATE);
    renderDailyTrendCharts();
}

let dailySortColumn = 'notional';
let dailySortAsc = false;

function updateDailyDate(date) {
    SELECTED_DATE = date;
    
    const dayData = FILTERED_DATA.filter(d => d.date === date);
    
    // Update metrics
    const totalNotional = dayData.reduce((sum, d) => sum + d.notional, 0);
    const totalVolume = dayData.reduce((sum, d) => sum + d.volume, 0);
    const avgCapturedAlpha = dayData.length > 0 ?
        dayData.reduce((sum, d) => sum + getCapturedAlpha(d), 0) / dayData.length : 0;
    const dirConsistencyRate = dayData.length > 0 ?
        dayData.filter(d => d.dirConsistency).length / dayData.length * 100 : 0;

    document.getElementById('dailyMetrics').innerHTML = `
        <div class="metric-card">
            <div class="metric-value">${formatCurrency(totalNotional, true)}</div>
            <div class="metric-label">Daily Notional</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${formatNumber(dayData.length)}</div>
            <div class="metric-label">Observations</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${formatNumber(totalVolume / 1e6, 1)}M</div>
            <div class="metric-label">Shares Traded</div>
        </div>
        <div class="metric-card">
            <div class="metric-value ${getValueClass(avgCapturedAlpha)}">${formatBps(avgCapturedAlpha, true)}</div>
            <div class="metric-label">Avg Captured Alpha</div>
        </div>
        <div class="metric-card">
            <div class="metric-value positive">${formatPercent(dirConsistencyRate)}</div>
            <div class="metric-label">Price Continuity</div>
        </div>
    `;
    
    document.getElementById('dailySectorSubtitle').textContent = `For ${date}`;
    document.getElementById('dailyTableSubtitle').textContent = `Top 50 by notional for ${date}`;
    
    renderDailySectorChart(dayData);
    renderDailyHistogram(dayData);
    renderDailyTable(dayData);
}

function renderDailyTrendCharts() {
    // Aggregate by date
    const dailyStats = LOOKUP.dates.map(date => {
        const dayData = FILTERED_DATA.filter(d => d.date === date);
        return {
            date: date,
            notional: dayData.reduce((sum, d) => sum + d.notional, 0),
            avgTiming: dayData.length > 0 ?
                dayData.reduce((sum, d) => sum + getCapturedAlpha(d), 0) / dayData.length : 0,
            count: dayData.length
        };
    });
    
    const labels = dailyStats.map(d => d.date.substring(5));
    const timingData = dailyStats.map(d => d.avgTiming);
    const notionalData = dailyStats.map(d => d.notional / 1e9);
    
    // Calculate 5-day MA
    const timingMA = timingData.map((val, idx) => {
        if (idx < 4) return null;
        return timingData.slice(idx - 4, idx + 1).reduce((a, b) => a + b, 0) / 5;
    });
    
    const notionalMA = notionalData.map((val, idx) => {
        if (idx < 4) return null;
        return notionalData.slice(idx - 4, idx + 1).reduce((a, b) => a + b, 0) / 5;
    });
    
    // Captured Alpha Trend
    const ctx1 = document.createElement('canvas');
    document.getElementById('dailyTimingChart').innerHTML = '';
    document.getElementById('dailyTimingChart').appendChild(ctx1);
    
    chartInstances.dailyTimingChart = new Chart(ctx1, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Daily Avg',
                    data: timingData,
                    backgroundColor: timingData.map(v => v >= 0 ? 'rgba(52, 211, 153, 0.7)' : 'rgba(248, 113, 113, 0.7)'),
                    borderColor: timingData.map(v => v >= 0 ? '#34d399' : '#f87171'),
                    borderWidth: 1,
                    borderRadius: 3
                },
                {
                    type: 'line',
                    label: '5-Day MA',
                    data: timingMA,
                    borderColor: '#c9a227',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: 'top', labels: { color: '#9ca3b4', boxWidth: 12 } }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(156, 163, 180, 0.1)' },
                    ticks: { color: '#6b7280', callback: v => v + ' bps' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#6b7280', maxRotation: 45, font: { size: 10 } }
                }
            }
        }
    });
    
    // Notional Volume Trend
    const ctx2 = document.createElement('canvas');
    document.getElementById('dailyNotionalChart').innerHTML = '';
    document.getElementById('dailyNotionalChart').appendChild(ctx2);
    
    chartInstances.dailyNotionalChart = new Chart(ctx2, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Daily Notional',
                    data: notionalData,
                    backgroundColor: 'rgba(201, 162, 39, 0.7)',
                    borderColor: '#c9a227',
                    borderWidth: 1,
                    borderRadius: 3
                },
                {
                    type: 'line',
                    label: '5-Day MA',
                    data: notionalMA,
                    borderColor: '#4f8bf9',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: 'top', labels: { color: '#9ca3b4', boxWidth: 12 } }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(156, 163, 180, 0.1)' },
                    ticks: { color: '#6b7280', callback: v => '$' + v + 'B' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#6b7280', maxRotation: 45, font: { size: 10 } }
                }
            }
        }
    });
}

function renderDailySectorChart(dayData) {
    const sectorStats = {};
    dayData.forEach(d => {
        const sector = d.sector.length > 20 ? d.sector.substring(0, 20) + '...' : d.sector;
        if (!sectorStats[sector]) sectorStats[sector] = 0;
        sectorStats[sector] += d.notional;
    });
    
    const sorted = Object.entries(sectorStats).sort((a, b) => b[1] - a[1]).slice(0, 10);
    
    const ctx = document.createElement('canvas');
    document.getElementById('dailySectorChart').innerHTML = '';
    document.getElementById('dailySectorChart').appendChild(ctx);
    
    chartInstances.dailySectorChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sorted.map(s => s[0]),
            datasets: [{
                data: sorted.map(s => s[1] / 1e6),
                backgroundColor: 'rgba(201, 162, 39, 0.7)',
                borderColor: '#c9a227',
                borderWidth: 1,
                borderRadius: 3
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    grid: { color: 'rgba(156, 163, 180, 0.1)' },
                    ticks: { color: '#6b7280', callback: v => '$' + v + 'M' }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#9ca3b4', font: { size: 11 } }
                }
            }
        }
    });
}

function renderDailyHistogram(dayData) {
    const timingVals = dayData.map(d => getCapturedAlpha(d));
    
    // Create bins
    const binSize = 50;
    const min = Math.floor(Math.min(...timingVals) / binSize) * binSize;
    const max = Math.ceil(Math.max(...timingVals) / binSize) * binSize;
    
    const bins = {};
    for (let i = min; i <= max; i += binSize) {
        bins[i] = 0;
    }
    
    timingVals.forEach(v => {
        const bin = Math.floor(v / binSize) * binSize;
        if (bins[bin] !== undefined) bins[bin]++;
    });
    
    const ctx = document.createElement('canvas');
    document.getElementById('dailyHistogram').innerHTML = '';
    document.getElementById('dailyHistogram').appendChild(ctx);
    
    const binLabels = Object.keys(bins).map(Number).sort((a, b) => a - b);
    
    chartInstances.dailyHistogram = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: binLabels.map(b => b + ' bps'),
            datasets: [{
                data: binLabels.map(b => bins[b]),
                backgroundColor: binLabels.map(b => b >= 0 ? 'rgba(52, 211, 153, 0.7)' : 'rgba(248, 113, 113, 0.7)'),
                borderColor: binLabels.map(b => b >= 0 ? '#34d399' : '#f87171'),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    grid: { color: 'rgba(156, 163, 180, 0.1)' },
                    ticks: { color: '#6b7280' },
                    title: { display: true, text: 'Observations', color: '#6b7280' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#6b7280', maxRotation: 45, font: { size: 9 } }
                }
            }
        }
    });
}

function renderDailyTable(dayData) {
    // Sort
    let sorted = [...dayData];
    sorted.sort((a, b) => {
        let aVal, bVal;
        switch(dailySortColumn) {
            case 'symbol': aVal = a.symbol; bVal = b.symbol; break;
            case 'notional': aVal = a.notional; bVal = b.notional; break;
            case 'capturedAlpha': aVal = getCapturedAlpha(a); bVal = getCapturedAlpha(b); break;
            case 'refGap': aVal = getRefGap(a); bVal = getRefGap(b); break;
            default: aVal = a.notional; bVal = b.notional;
        }
        if (typeof aVal === 'string') {
            return dailySortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        return dailySortAsc ? aVal - bVal : bVal - aVal;
    });
    
    sorted = sorted.slice(0, 50);
    
    const tbody = document.getElementById('dailyTableBody');
    tbody.innerHTML = sorted.map(d => `
        <tr onclick="showPositionModal('${d.symbol}', '${d.date}')">
            <td class="symbol">${d.symbol}</td>
            <td class="company" title="${d.company}">${d.company.substring(0, 25)}</td>
            <td>${d.assetType}</td>
            <td class="muted">${d.sector.substring(0, 15)}</td>
            <td class="mono">${formatCurrency(d.notional, true)}</td>
            <td class="mono ${getValueClass(getCapturedAlpha(d))}">${formatBps(getCapturedAlpha(d), true)}</td>
            <td class="mono ${getValueClass(getRefGap(d))}">${formatBps(getRefGap(d), true)}</td>
            <td>${d.gapDirection}</td>
            <td>${d.dirConsistency ? '<span class="positive">✓</span>' : '<span class="negative">✗</span>'}</td>
        </tr>
    `).join('');
}

function sortDailyTable(column) {
    if (dailySortColumn === column) {
        dailySortAsc = !dailySortAsc;
    } else {
        dailySortColumn = column;
        dailySortAsc = false;
    }
    
    const dayData = FILTERED_DATA.filter(d => d.date === SELECTED_DATE);
    renderDailyTable(dayData);
}

// ============================================================================
// TAB 3: MARKET STRUCTURE
// ============================================================================

function renderStructureTab() {
    const container = document.getElementById('tab-structure');
    
    container.innerHTML = `
        <!-- Asset Type Distribution -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Asset Type Distribution</h3>
            </div>
            <div class="chart-grid">
                <div class="card">
                    <h4 class="card-title">Notional by Asset Type</h4>
                    <div class="chart-container" id="structureAssetChart"></div>
                </div>
                <div class="card">
                    <h4 class="card-title">Observation Count by Asset Type</h4>
                    <div class="chart-container" id="structureAssetCountChart"></div>
                </div>
            </div>
        </section>
        
        <!-- Sector Breakdown -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Sector Analysis</h3>
                <span class="section-subtitle">Top 15 sectors by notional</span>
            </div>
            <div class="chart-grid single">
                <div class="card">
                    <div class="chart-container large" id="structureSectorChart"></div>
                </div>
            </div>
        </section>
        
        <!-- Leverage Analysis (ETFs) -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">ETF Leverage Analysis</h3>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Leverage Multiple</th>
                            <th>Observations</th>
                            <th>Notional</th>
                            <th>Avg Captured Alpha</th>
                            <th>Avg Ref Gap</th>
                            <th>Continuity Rate</th>
                        </tr>
                    </thead>
                    <tbody id="structureLeverageTable"></tbody>
                </table>
            </div>
        </section>
        
        <!-- Sector Performance Table -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Sector Performance Comparison</h3>
            </div>
            <div class="table-container">
                <div class="table-scroll" style="max-height: 400px;">
                    <table>
                        <thead>
                            <tr>
                                <th>Sector</th>
                                <th>Observations</th>
                                <th>Notional</th>
                                <th>Avg Captured Alpha</th>
                                <th>Continuity Rate</th>
                            </tr>
                        </thead>
                        <tbody id="structureSectorTable"></tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
    
    renderStructureCharts();
    renderStructureTables();
}

function renderStructureCharts() {
    // Asset Type pie charts
    const stockData = FILTERED_DATA.filter(d => d.assetType === 'Stock');
    const etfData = FILTERED_DATA.filter(d => d.assetType === 'ETF');
    
    const stockNotional = stockData.reduce((sum, d) => sum + d.notional, 0);
    const etfNotional = etfData.reduce((sum, d) => sum + d.notional, 0);
    
    // Notional pie
    const ctx1 = document.createElement('canvas');
    document.getElementById('structureAssetChart').appendChild(ctx1);
    
    chartInstances.assetPie1 = new Chart(ctx1, {
        type: 'doughnut',
        data: {
            labels: ['Stocks', 'ETFs'],
            datasets: [{
                data: [stockNotional, etfNotional],
                backgroundColor: ['#34d399', '#c9a227'],
                borderColor: ['#059669', '#a68b1f'],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#9ca3b4', padding: 20 }
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const total = stockNotional + etfNotional;
                            const pct = (ctx.raw / total * 100).toFixed(1);
                            return `${ctx.label}: ${formatCurrency(ctx.raw, true)} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
    
    // Count pie
    const ctx2 = document.createElement('canvas');
    document.getElementById('structureAssetCountChart').appendChild(ctx2);
    
    chartInstances.assetPie2 = new Chart(ctx2, {
        type: 'doughnut',
        data: {
            labels: ['Stocks', 'ETFs'],
            datasets: [{
                data: [stockData.length, etfData.length],
                backgroundColor: ['#34d399', '#c9a227'],
                borderColor: ['#059669', '#a68b1f'],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#9ca3b4', padding: 20 }
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const total = stockData.length + etfData.length;
                            const pct = (ctx.raw / total * 100).toFixed(1);
                            return `${ctx.label}: ${formatNumber(ctx.raw)} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
    
    // Sector horizontal bar
    const sectorStats = {};
    FILTERED_DATA.forEach(d => {
        if (!sectorStats[d.sector]) {
            sectorStats[d.sector] = { notional: 0, count: 0, capturedSum: 0 };
        }
        sectorStats[d.sector].notional += d.notional;
        sectorStats[d.sector].count++;
        sectorStats[d.sector].capturedSum += getCapturedAlpha(d);
    });
    
    const topSectors = Object.entries(sectorStats)
        .sort((a, b) => b[1].notional - a[1].notional)
        .slice(0, 15);
    
    const ctx3 = document.createElement('canvas');
    document.getElementById('structureSectorChart').appendChild(ctx3);
    
    chartInstances.sectorBar = new Chart(ctx3, {
        type: 'bar',
        data: {
            labels: topSectors.map(s => s[0].length > 25 ? s[0].substring(0, 25) + '...' : s[0]),
            datasets: [{
                label: 'Notional ($M)',
                data: topSectors.map(s => s[1].notional / 1e6),
                backgroundColor: 'rgba(201, 162, 39, 0.7)',
                borderColor: '#c9a227',
                borderWidth: 1,
                borderRadius: 3
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { 
                legend: { display: false }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(156, 163, 180, 0.1)' },
                    ticks: { color: '#6b7280', callback: v => '$' + v + 'M' }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#9ca3b4', font: { size: 11 } }
                }
            }
        }
    });
}

function renderStructureTables() {
    // Leverage Analysis
    const etfData = FILTERED_DATA.filter(d => d.assetType === 'ETF');
    const leverageStats = {};
    
    etfData.forEach(d => {
        const lev = d.leverageMult || '1x';
        if (!leverageStats[lev]) {
            leverageStats[lev] = { count: 0, notional: 0, capturedSum: 0, refGapSum: 0, consistent: 0 };
        }
        leverageStats[lev].count++;
        leverageStats[lev].notional += d.notional;
        leverageStats[lev].capturedSum += getCapturedAlpha(d);
        leverageStats[lev].refGapSum += getRefGap(d);
        if (d.dirConsistency) leverageStats[lev].consistent++;
    });

    const leverageOrder = ['-3x', '-2x', '-1x', '1x', '2x', '3x'];
    const sortedLeverage = Object.entries(leverageStats).sort((a, b) => {
        const aIdx = leverageOrder.indexOf(a[0]);
        const bIdx = leverageOrder.indexOf(b[0]);
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    });

    document.getElementById('structureLeverageTable').innerHTML = sortedLeverage.map(([lev, stats]) => {
        const avgTiming = stats.capturedSum / stats.count;
        const avgRefGap = stats.refGapSum / stats.count;
        const contRate = stats.consistent / stats.count * 100;
        return `
            <tr>
                <td style="font-weight: 600;">${lev}</td>
                <td>${formatNumber(stats.count)}</td>
                <td class="mono">${formatCurrency(stats.notional, true)}</td>
                <td class="mono ${getValueClass(avgTiming)}">${formatBps(avgTiming, true)}</td>
                <td class="mono ${getValueClass(avgRefGap)}">${formatBps(avgRefGap, true)}</td>
                <td class="positive">${formatPercent(contRate)}</td>
            </tr>
        `;
    }).join('');
    
    // Sector Performance Table
    const sectorStats = {};
    FILTERED_DATA.forEach(d => {
        if (!sectorStats[d.sector]) {
            sectorStats[d.sector] = { count: 0, notional: 0, capturedSum: 0, consistent: 0 };
        }
        sectorStats[d.sector].count++;
        sectorStats[d.sector].notional += d.notional;
        sectorStats[d.sector].capturedSum += getCapturedAlpha(d);
        if (d.dirConsistency) sectorStats[d.sector].consistent++;
    });

    const sortedSectors = Object.entries(sectorStats).sort((a, b) => b[1].notional - a[1].notional);

    document.getElementById('structureSectorTable').innerHTML = sortedSectors.map(([sector, stats]) => {
        const avgTiming = stats.capturedSum / stats.count;
        const contRate = stats.consistent / stats.count * 100;
        return `
            <tr>
                <td style="font-weight: 500;">${sector.substring(0, 30)}</td>
                <td>${formatNumber(stats.count)}</td>
                <td class="mono">${formatCurrency(stats.notional, true)}</td>
                <td class="mono ${getValueClass(avgTiming)}">${formatBps(avgTiming, true)}</td>
                <td class="positive">${formatPercent(contRate)}</td>
            </tr>
        `;
    }).join('');
}

// ============================================================================
// TAB 4: QUADRANT ANALYSIS
// ============================================================================

function renderQuadrantTab() {
    const container = document.getElementById('tab-quadrant');
    
    // Calculate quadrant stats
    const quadrants = { Q1: [], Q2: [], Q3: [], Q4: [] };
    FILTERED_DATA.forEach(d => {
        quadrants[getQuadrant(d)].push(d);
    });
    
    container.innerHTML = `
        <!-- Quadrant Counts -->
        <div class="metrics-grid" style="grid-template-columns: repeat(4, 1fr);">
            ${['Q1', 'Q2', 'Q3', 'Q4'].map(q => {
                const info = getQuadrantInfo(q);
                return `
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${info.color};">${formatNumber(quadrants[q].length)}</div>
                        <div class="metric-label">${q}: ${info.name}</div>
                    </div>
                `;
            }).join('')}
        </div>
        
        <!-- Quadrant Scatter Plot -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Quadrant Analysis</h3>
                <span class="section-subtitle">Timing Differential vs Reference Gap ${USE_WINSORIZED ? '(Winsorized)' : '(Full Range)'}</span>
            </div>
            <div class="card">
                <div id="quadrantScatter" style="height: 500px;"></div>
                <div class="legend">
                    <div class="legend-item"><div class="legend-dot" style="background: #34d399;"></div> Q1: Momentum</div>
                    <div class="legend-item"><div class="legend-dot" style="background: #fbbf24;"></div> Q2: Mean Reversion</div>
                    <div class="legend-item"><div class="legend-dot" style="background: #f87171;"></div> Q3: Protection</div>
                    <div class="legend-item"><div class="legend-dot" style="background: #a78bfa;"></div> Q4: Top Tick</div>
                </div>
            </div>
        </section>
        
        <!-- Quadrant Performance Table -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Quadrant Performance Summary</h3>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Quadrant</th>
                            <th>Description</th>
                            <th>Observations</th>
                            <th>Notional</th>
                            <th>Avg Captured Alpha</th>
                            <th>Avg Ref Gap</th>
                            <th>Continuity Rate</th>
                        </tr>
                    </thead>
                    <tbody id="quadrantSummaryTable"></tbody>
                </table>
            </div>
        </section>
        
        <!-- Top Positions by Quadrant -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Position-Level Analysis</h3>
                <span class="section-subtitle">Top 100 positions by absolute captured alpha</span>
            </div>
            <div class="table-container">
                <div class="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>Symbol</th>
                                <th>Company</th>
                                <th>Date</th>
                                <th>Type</th>
                                <th>Notional</th>
                                <th>Captured Alpha</th>
                                <th>Ref Gap</th>
                                <th>VS Open</th>
                                <th>VS Close</th>
                                <th>Quadrant</th>
                                <th>Dir</th>
                            </tr>
                        </thead>
                        <tbody id="quadrantPositionTable"></tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
    
    renderQuadrantScatter();
    renderQuadrantTables(quadrants);
}

function renderQuadrantScatter() {
    const traces = ['Q1', 'Q2', 'Q3', 'Q4'].map(q => {
        const info = getQuadrantInfo(q);
        const quadData = FILTERED_DATA.filter(d => getQuadrant(d) === q);
        
        return {
            x: quadData.map(d => getRefGap(d)),
            y: quadData.map(d => getTimingDiff(d)),
            mode: 'markers',
            type: 'scatter',
            name: `${q}: ${info.name}`,
            marker: {
                color: info.color,
                size: quadData.map(d => Math.sqrt(d.notional / 1e6) * 3 + 4),
                opacity: 0.6,
                line: { color: 'rgba(255,255,255,0.3)', width: 1 }
            },
            text: quadData.map(d =>
                `<b>${d.symbol}</b><br>${d.company.substring(0, 30)}<br>` +
                `Notional: ${formatCurrency(d.notional, true)}<br>` +
                `Captured: ${formatBps(getCapturedAlpha(d), true)}<br>` +
                `Ref Gap: ${formatBps(getRefGap(d), true)}<br>` +
                `Date: ${d.date}`
            ),
            hovertemplate: '%{text}<extra></extra>',
            customdata: quadData.map(d => ({ symbol: d.symbol, date: d.date }))
        };
    });
    
    const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { family: 'Inter, sans-serif', color: '#9ca3b4' },
        xaxis: {
            title: { text: 'Reference Gap (bps)', font: { size: 12 } },
            zeroline: true,
            zerolinewidth: 2,
            zerolinecolor: 'rgba(201, 162, 39, 0.5)',
            gridcolor: 'rgba(156, 163, 180, 0.1)',
            tickfont: { size: 10 }
        },
        yaxis: {
            title: { text: 'Timing Differential (bps)', font: { size: 12 } },
            zeroline: true,
            zerolinewidth: 2,
            zerolinecolor: 'rgba(201, 162, 39, 0.5)',
            gridcolor: 'rgba(156, 163, 180, 0.1)',
            tickfont: { size: 10 }
        },
        showlegend: false,
        hovermode: 'closest',
        margin: { t: 20, r: 20, b: 50, l: 60 }
    };
    
    Plotly.newPlot('quadrantScatter', traces, layout, { responsive: true });
    
    // Add click handler
    document.getElementById('quadrantScatter').on('plotly_click', function(data) {
        const point = data.points[0];
        if (point.customdata) {
            showPositionModal(point.customdata.symbol, point.customdata.date);
        }
    });
}

function renderQuadrantTables(quadrants) {
    // Summary table
    const summaryBody = document.getElementById('quadrantSummaryTable');
    summaryBody.innerHTML = ['Q1', 'Q2', 'Q3', 'Q4'].map(q => {
        const info = getQuadrantInfo(q);
        const data = quadrants[q];
        const notional = data.reduce((sum, d) => sum + d.notional, 0);
        const avgCaptured = data.length > 0 ? data.reduce((sum, d) => sum + getCapturedAlpha(d), 0) / data.length : 0;
        const avgRefGap = data.length > 0 ? data.reduce((sum, d) => sum + getRefGap(d), 0) / data.length : 0;
        const contRate = data.length > 0 ? data.filter(d => d.dirConsistency).length / data.length * 100 : 0;
        
        return `
            <tr>
                <td><span class="quad-badge ${q.toLowerCase()}">${q}</span></td>
                <td style="color: ${info.color};">${info.name}</td>
                <td>${formatNumber(data.length)}</td>
                <td class="mono">${formatCurrency(notional, true)}</td>
                <td class="mono ${getValueClass(avgCaptured)}">${formatBps(avgCaptured, true)}</td>
                <td class="mono ${getValueClass(avgRefGap)}">${formatBps(avgRefGap, true)}</td>
                <td>${formatPercent(contRate)}</td>
            </tr>
        `;
    }).join('');
    
    // Position table - top 100 by absolute captured alpha
    const sorted = [...FILTERED_DATA]
        .sort((a, b) => Math.abs(getCapturedAlpha(b)) - Math.abs(getCapturedAlpha(a)))
        .slice(0, 100);
    
    const positionBody = document.getElementById('quadrantPositionTable');
    positionBody.innerHTML = sorted.map(d => {
        const q = getQuadrant(d);
        const vsOpen = d.vwap && d.nextOpen ? ((d.nextOpen - d.vwap) / d.vwap) * 10000 : null;
        const vsClose = d.vwap && d.nextClose ? ((d.nextClose - d.vwap) / d.vwap) * 10000 : null;
        
        return `
            <tr onclick="showPositionModal('${d.symbol}', '${d.date}')">
                <td class="symbol">${d.symbol}</td>
                <td class="company" title="${d.company}">${d.company.substring(0, 20)}</td>
                <td class="muted">${d.date.substring(5)}</td>
                <td>${d.assetType}</td>
                <td class="mono">${formatCurrency(d.notional, true)}</td>
                <td class="mono ${getValueClass(getCapturedAlpha(d))}">${formatBps(getCapturedAlpha(d), true)}</td>
                <td class="mono ${getValueClass(getRefGap(d))}">${formatBps(getRefGap(d), true)}</td>
                <td class="mono ${getValueClass(vsOpen)}">${vsOpen !== null ? formatBps(vsOpen, true) : '-'}</td>
                <td class="mono ${getValueClass(vsClose)}">${vsClose !== null ? formatBps(vsClose, true) : '-'}</td>
                <td><span class="quad-badge ${q.toLowerCase()}">${q}</span></td>
                <td>${d.dirConsistency ? '<span class="positive">✓</span>' : '<span class="negative">✗</span>'}</td>
            </tr>
        `;
    }).join('');
}

// ============================================================================
// TAB 5: DATA EXPLORER
// ============================================================================

function renderExplorerTab() {
    const container = document.getElementById('tab-explorer');
    
    container.innerHTML = `
        <!-- Explorer Filters -->
        <div class="filter-panel">
            <div class="filter-group">
                <label>Symbol Search</label>
                <input type="text" id="explorerSymbol" placeholder="Enter symbol..." 
                    oninput="updateExplorerFilters()">
            </div>
            <div class="filter-group">
                <label>Gap Direction</label>
                <select id="explorerGapDir" onchange="updateExplorerFilters()">
                    <option value="all">All</option>
                    <option value="UP">Gap Up</option>
                    <option value="DOWN">Gap Down</option>
                </select>
            </div>
            <div class="filter-group" style="align-self: flex-end;">
                <button class="btn-export" onclick="exportExplorerCSV()">
                    <i class="fas fa-download"></i> Export CSV
                </button>
            </div>
        </div>
        
        <div class="result-count" id="explorerResultCount">--</div>
        
        <div class="table-container">
            <div class="table-scroll" style="max-height: 600px;">
                <table>
                    <thead>
                        <tr>
                            <th class="sortable" onclick="sortExplorer('symbol')">Symbol</th>
                            <th>Company</th>
                            <th class="sortable" onclick="sortExplorer('date')">Date</th>
                            <th>Type</th>
                            <th>Sector</th>
                            <th class="sortable" onclick="sortExplorer('notional')">Notional</th>
                            <th class="sortable" onclick="sortExplorer('capturedAlpha')">Captured Alpha</th>
                            <th class="sortable" onclick="sortExplorer('refGap')">Ref Gap</th>
                            <th>Gap Dir</th>
                            <th>Dir</th>
                        </tr>
                    </thead>
                    <tbody id="explorerTableBody"></tbody>
                </table>
            </div>
            <div class="pagination" id="explorerPagination"></div>
        </div>
    `;
    
    renderExplorerTable();
}

function updateExplorerFilters() {
    EXPLORER_FILTERS.symbol = document.getElementById('explorerSymbol').value.toUpperCase();
    EXPLORER_FILTERS.gapDirection = document.getElementById('explorerGapDir').value;
    EXPLORER_PAGE = 1;
    renderExplorerTable();
}

function getFilteredExplorerData() {
    return FILTERED_DATA.filter(d => {
        if (EXPLORER_FILTERS.symbol && !d.symbol.includes(EXPLORER_FILTERS.symbol)) return false;
        if (EXPLORER_FILTERS.gapDirection !== 'all' && d.gapDirection !== EXPLORER_FILTERS.gapDirection) return false;
        return true;
    });
}

function renderExplorerTable() {
    let data = getFilteredExplorerData();
    
    // Sort
    data.sort((a, b) => {
        let aVal, bVal;
        switch(EXPLORER_SORT.column) {
            case 'symbol': aVal = a.symbol; bVal = b.symbol; break;
            case 'date': aVal = a.date; bVal = b.date; break;
            case 'notional': aVal = a.notional; bVal = b.notional; break;
            case 'capturedAlpha': aVal = getCapturedAlpha(a); bVal = getCapturedAlpha(b); break;
            case 'refGap': aVal = getRefGap(a); bVal = getRefGap(b); break;
            default: aVal = a.notional; bVal = b.notional;
        }
        if (typeof aVal === 'string') {
            return EXPLORER_SORT.ascending ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        return EXPLORER_SORT.ascending ? aVal - bVal : bVal - aVal;
    });
    
    // Paginate
    const totalPages = Math.ceil(data.length / ROWS_PER_PAGE);
    const start = (EXPLORER_PAGE - 1) * ROWS_PER_PAGE;
    const pageData = data.slice(start, start + ROWS_PER_PAGE);
    
    // Update result count
    document.getElementById('explorerResultCount').innerHTML = 
        `Showing <strong>${start + 1}-${Math.min(start + ROWS_PER_PAGE, data.length)}</strong> of <strong>${formatNumber(data.length)}</strong> observations`;
    
    // Render table
    const tbody = document.getElementById('explorerTableBody');
    tbody.innerHTML = pageData.map(d => `
        <tr onclick="showPositionModal('${d.symbol}', '${d.date}')">
            <td class="symbol">${d.symbol}</td>
            <td class="company" title="${d.company}">${d.company.substring(0, 25)}</td>
            <td class="muted">${d.date}</td>
            <td>${d.assetType}</td>
            <td class="muted">${d.sector.substring(0, 15)}</td>
            <td class="mono">${formatCurrency(d.notional, true)}</td>
            <td class="mono ${getValueClass(getCapturedAlpha(d))}">${formatBps(getCapturedAlpha(d), true)}</td>
            <td class="mono ${getValueClass(getRefGap(d))}">${formatBps(getRefGap(d), true)}</td>
            <td>${d.gapDirection}</td>
            <td>${d.dirConsistency ? '<span class="positive">✓</span>' : '<span class="negative">✗</span>'}</td>
        </tr>
    `).join('');

    // Render pagination
    const paginationDiv = document.getElementById('explorerPagination');
    paginationDiv.innerHTML = `
        <button onclick="explorerPage(1)" ${EXPLORER_PAGE === 1 ? 'disabled' : ''}>First</button>
        <button onclick="explorerPage(${EXPLORER_PAGE - 1})" ${EXPLORER_PAGE === 1 ? 'disabled' : ''}>Prev</button>
        <span>Page ${EXPLORER_PAGE} of ${totalPages}</span>
        <button onclick="explorerPage(${EXPLORER_PAGE + 1})" ${EXPLORER_PAGE === totalPages ? 'disabled' : ''}>Next</button>
        <button onclick="explorerPage(${totalPages})" ${EXPLORER_PAGE === totalPages ? 'disabled' : ''}>Last</button>
    `;
    
    // Update sort indicators
    document.querySelectorAll('#tab-explorer th.sortable').forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
    });
    const sortedTh = document.querySelector(`#tab-explorer th[onclick="sortExplorer('${EXPLORER_SORT.column}')"]`);
    if (sortedTh) {
        sortedTh.classList.add(EXPLORER_SORT.ascending ? 'sorted-asc' : 'sorted-desc');
    }
}

function sortExplorer(column) {
    if (EXPLORER_SORT.column === column) {
        EXPLORER_SORT.ascending = !EXPLORER_SORT.ascending;
    } else {
        EXPLORER_SORT.column = column;
        EXPLORER_SORT.ascending = column === 'symbol' || column === 'date';
    }
    renderExplorerTable();
}

function explorerPage(page) {
    EXPLORER_PAGE = page;
    renderExplorerTable();
}

function exportExplorerCSV() {
    const data = getFilteredExplorerData();
    
    const headers = ['Symbol', 'Company', 'Date', 'Asset Type', 'Sector', 'Notional',
        'Captured Alpha (bps)', 'Reference Gap (bps)', 'Timing Differential (bps)', 'Gap Direction', 'Directional Consistency'];

    const rows = data.map(d => [
        d.symbol,
        `"${d.company.replace(/"/g, '""')}"`,
        d.date,
        d.assetType,
        `"${d.sector.replace(/"/g, '""')}"`,
        d.notional.toFixed(2),
        getCapturedAlpha(d).toFixed(2),
        getRefGap(d).toFixed(2),
        getTimingDiff(d).toFixed(2),
        d.gapDirection,
        d.dirConsistency ? 'Yes' : 'No'
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sapinover_overnight_data_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================================
// ANALYTICS UTILITIES
// ============================================================================

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdDev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function percentile(arr, p) {
    const s = [...arr].sort((a, b) => a - b);
    const i = (p / 100) * (s.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (i - lo) * (s[hi] - s[lo]);
}
function pearsonCorr(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) return 0;
    const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - mx, dy = y[i] - my;
        num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    const den = Math.sqrt(dx2 * dy2);
    return den === 0 ? 0 : num / den;
}
function skewness(arr) {
    const n = arr.length, m = mean(arr), s = stdDev(arr);
    if (s === 0 || n < 3) return 0;
    return (n / ((n - 1) * (n - 2))) * arr.reduce((sum, v) => sum + ((v - m) / s) ** 3, 0);
}
function kurtosis(arr) {
    const n = arr.length, m = mean(arr), s = stdDev(arr);
    if (s === 0 || n < 4) return 0;
    const k4 = arr.reduce((sum, v) => sum + ((v - m) / s) ** 4, 0) / n;
    return k4 - 3; // excess kurtosis
}

// K-Means with K-Means++ seeding
function kMeans(data, k, maxIter = 50) {
    const n = data.length, dims = data[0].length;
    const centroids = [data[Math.floor(Math.random() * n)]];
    for (let c = 1; c < k; c++) {
        const dists = data.map(p => Math.min(...centroids.map(ce =>
            ce.reduce((s, v, d) => s + (v - p[d]) ** 2, 0))));
        const total = dists.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { centroids.push([...data[i]]); break; } }
        if (centroids.length <= c) centroids.push([...data[Math.floor(Math.random() * n)]]);
    }
    let assignments = new Array(n).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
            let minD = Infinity, minC = 0;
            for (let c = 0; c < k; c++) {
                const d = centroids[c].reduce((s, v, dim) => s + (v - data[i][dim]) ** 2, 0);
                if (d < minD) { minD = d; minC = c; }
            }
            if (assignments[i] !== minC) { changed = true; assignments[i] = minC; }
        }
        if (!changed) break;
        for (let c = 0; c < k; c++) {
            const members = data.filter((_, i) => assignments[i] === c);
            if (members.length > 0) {
                for (let d = 0; d < dims; d++) centroids[c][d] = mean(members.map(m => m[d]));
            }
        }
    }
    return { assignments, centroids };
}

function normalizeFeatures(data) {
    const dims = data[0].length;
    const mins = Array(dims).fill(Infinity), maxs = Array(dims).fill(-Infinity);
    data.forEach(p => p.forEach((v, d) => { if (v < mins[d]) mins[d] = v; if (v > maxs[d]) maxs[d] = v; }));
    return {
        normalized: data.map(p => p.map((v, d) => maxs[d] === mins[d] ? 0.5 : (v - mins[d]) / (maxs[d] - mins[d]))),
        mins, maxs
    };
}

const CLUSTER_COLORS = ['#c9a227', '#4f8bf9', '#34d399', '#f87171', '#a78bfa', '#fbbf24', '#ec4899', '#06b6d4'];

function getFeatureValue(d, feat) {
    switch(feat) {
        case 'capturedAlpha': return getCapturedAlpha(d);
        case 'timingDiff': return getTimingDiff(d);
        case 'refGap': return getRefGap(d);
        case 'notional': return Math.log10(Math.max(d.notional, 1));
        case 'volume': return Math.log10(Math.max(d.volume, 1));
        case 'totalGap': return d.totalGap;
        default: return 0;
    }
}

const FEATURE_LABELS = {
    capturedAlpha: 'Captured Alpha',
    timingDiff: 'Timing Diff',
    refGap: 'Reference Gap',
    notional: 'Log Notional',
    volume: 'Log Volume',
    totalGap: 'Total Gap'
};

// Plotly dark layout defaults
function plotlyDarkLayout(overrides = {}) {
    return Object.assign({
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#9ca3b4', family: 'Inter, sans-serif', size: 11 },
        margin: { l: 55, r: 20, t: 40, b: 45 },
        xaxis: { gridcolor: 'rgba(156,163,180,0.08)', zerolinecolor: 'rgba(156,163,180,0.15)' },
        yaxis: { gridcolor: 'rgba(156,163,180,0.08)', zerolinecolor: 'rgba(156,163,180,0.15)' },
    }, overrides);
}

function plotlyConfig() {
    return { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['autoScale2d'] };
}

// ============================================================================
// TAB 7: ML CLUSTERING
// ============================================================================

function renderClusteringTab() {
    const container = document.getElementById('tab-clustering');
    const features = ['capturedAlpha', 'refGap', 'notional', 'volume', 'timingDiff', 'totalGap'];

    container.innerHTML = `
        <div class="analytics-controls">
            <div class="control-group">
                <label>Features</label>
                <div class="feature-toggles" id="clusterFeatures">
                    ${features.map(f => `
                        <span class="feature-chip ${CLUSTER_STATE.features.includes(f) ? 'active' : ''}"
                              onclick="toggleClusterFeature('${f}')">${FEATURE_LABELS[f]}</span>
                    `).join('')}
                </div>
            </div>
            <div class="control-group">
                <label>Clusters (K)</label>
                <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="2" max="8" value="${CLUSTER_STATE.k}"
                           id="clusterK" oninput="document.getElementById('clusterKVal').textContent=this.value">
                    <span class="range-value" id="clusterKVal">${CLUSTER_STATE.k}</span>
                </div>
            </div>
            <div class="control-group">
                <label>&nbsp;</label>
                <button class="btn-action" onclick="runClustering()">
                    <i class="fas fa-play"></i> Run Clustering
                </button>
            </div>
        </div>

        <div id="clusterResults">
            <div class="card" style="text-align:center;padding:3rem;color:var(--text-muted);">
                <i class="fas fa-project-diagram" style="font-size:2rem;margin-bottom:1rem;opacity:0.3;"></i>
                <p>Select features and click "Run Clustering" to identify behavioral clusters in overnight observations.</p>
                <p style="font-size:0.78rem;margin-top:0.5rem;">Uses K-Means++ algorithm on ${formatNumber(FILTERED_DATA.length)} observations.</p>
            </div>
        </div>
    `;
}

function toggleClusterFeature(feat) {
    const idx = CLUSTER_STATE.features.indexOf(feat);
    if (idx >= 0) {
        if (CLUSTER_STATE.features.length <= 2) return; // need at least 2
        CLUSTER_STATE.features.splice(idx, 1);
    } else {
        CLUSTER_STATE.features.push(feat);
    }
    renderClusteringTab();
}

function runClustering() {
    CLUSTER_STATE.k = parseInt(document.getElementById('clusterK').value);
    const feats = CLUSTER_STATE.features;
    if (feats.length < 2) return;

    // Build feature matrix
    const rawData = FILTERED_DATA.map(d => feats.map(f => getFeatureValue(d, f)));
    const { normalized } = normalizeFeatures(rawData);
    const { assignments, centroids } = kMeans(normalized, CLUSTER_STATE.k);
    CLUSTER_STATE.results = { assignments, centroids };

    const resultsDiv = document.getElementById('clusterResults');

    // Cluster summary stats
    const clusterStats = [];
    for (let c = 0; c < CLUSTER_STATE.k; c++) {
        const members = FILTERED_DATA.filter((_, i) => assignments[i] === c);
        const tds = members.map(d => getCapturedAlpha(d));
        const rgs = members.map(d => getRefGap(d));
        const nots = members.map(d => d.notional);
        const cons = members.filter(d => d.dirConsistency).length;
        // Top symbols by frequency
        const symCounts = {};
        members.forEach(d => { symCounts[d.symbol] = (symCounts[d.symbol] || 0) + 1; });
        const topSyms = Object.entries(symCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

        clusterStats.push({
            id: c, count: members.length, color: CLUSTER_COLORS[c % CLUSTER_COLORS.length],
            avgCa: mean(tds), avgRg: mean(rgs), avgNot: mean(nots),
            consistency: members.length > 0 ? (cons / members.length * 100) : 0,
            topSymbols: topSyms.map(s => s[0]).join(', '),
            centroid: centroids[c]
        });
    }

    resultsDiv.innerHTML = `
        <div class="chart-grid">
            <div class="card">
                <h4 class="card-title">Cluster Scatter (${FEATURE_LABELS[feats[0]]} vs ${FEATURE_LABELS[feats[1]]})</h4>
                <div class="chart-container large" id="clusterScatter"></div>
            </div>
            <div class="card">
                <h4 class="card-title">Cluster Profiles (Radar)</h4>
                <div class="chart-container large" id="clusterRadar"></div>
            </div>
        </div>
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Cluster Summary</h3>
                <span class="section-subtitle">${formatNumber(FILTERED_DATA.length)} observations in ${CLUSTER_STATE.k} clusters</span>
            </div>
            <div class="table-container">
                <div class="table-scroll">
                    <table>
                        <thead><tr>
                            <th>Cluster</th><th>Count</th><th>Avg Captured Alpha</th>
                            <th>Avg Ref Gap</th><th>Avg Notional</th><th>Consistency</th><th>Top Symbols</th>
                        </tr></thead>
                        <tbody>
                            ${clusterStats.map(cs => `
                                <tr>
                                    <td><span class="cluster-dot" style="background:${cs.color}"></span>C${cs.id + 1}</td>
                                    <td>${formatNumber(cs.count)}</td>
                                    <td class="mono ${getValueClass(cs.avgCa)}">${formatBps(cs.avgCa, true)}</td>
                                    <td class="mono ${getValueClass(cs.avgRg)}">${formatBps(cs.avgRg, true)}</td>
                                    <td class="mono">${formatCurrency(cs.avgNot, true)}</td>
                                    <td class="positive">${formatPercent(cs.consistency)}</td>
                                    <td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${cs.topSymbols}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </section>
    `;

    // Scatter plot (first two features, raw values)
    const traces = [];
    for (let c = 0; c < CLUSTER_STATE.k; c++) {
        const members = FILTERED_DATA.filter((_, i) => assignments[i] === c);
        traces.push({
            x: members.map(d => getFeatureValue(d, feats[0])),
            y: members.map(d => getFeatureValue(d, feats[1])),
            mode: 'markers',
            type: 'scatter',
            name: `C${c + 1} (${members.length})`,
            text: members.map(d => `${d.symbol} | ${d.date}<br>CA: ${formatBps(getCapturedAlpha(d), true)}<br>Notional: ${formatCurrency(d.notional, true)}`),
            marker: {
                color: CLUSTER_COLORS[c % CLUSTER_COLORS.length],
                size: members.map(d => Math.sqrt(d.notional / 1e6) * 2 + 3),
                opacity: 0.6,
                line: { width: 0.5, color: 'rgba(255,255,255,0.15)' }
            },
            hovertemplate: '%{text}<extra></extra>'
        });
    }
    Plotly.newPlot('clusterScatter', traces, plotlyDarkLayout({
        title: null,
        xaxis: { title: FEATURE_LABELS[feats[0]], gridcolor: 'rgba(156,163,180,0.08)' },
        yaxis: { title: FEATURE_LABELS[feats[1]], gridcolor: 'rgba(156,163,180,0.08)' },
        legend: { font: { size: 10 } },
        margin: { l: 55, r: 20, t: 15, b: 50 }
    }), plotlyConfig());

    // Radar chart
    const radarCtx = document.createElement('canvas');
    document.getElementById('clusterRadar').innerHTML = '';
    document.getElementById('clusterRadar').appendChild(radarCtx);

    chartInstances.clusterRadar = new Chart(radarCtx, {
        type: 'radar',
        data: {
            labels: feats.map(f => FEATURE_LABELS[f]),
            datasets: clusterStats.map(cs => ({
                label: `C${cs.id + 1}`,
                data: cs.centroid,
                backgroundColor: cs.color + '22',
                borderColor: cs.color,
                borderWidth: 2,
                pointBackgroundColor: cs.color,
                pointRadius: 3
            }))
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { r: { beginAtZero: true, max: 1, grid: { color: 'rgba(156,163,180,0.1)' }, angleLines: { color: 'rgba(156,163,180,0.1)' }, pointLabels: { color: '#9ca3b4', font: { size: 11 } }, ticks: { display: false } } },
            plugins: { legend: { position: 'bottom', labels: { color: '#9ca3b4', boxWidth: 12, padding: 10 } } }
        }
    });
}

// ============================================================================
// TAB 8: CORRELATION / HEATMAP
// ============================================================================

function renderCorrelationTab() {
    const container = document.getElementById('tab-correlation');
    container.innerHTML = `
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Metric Correlation Matrix</h3>
                <span class="section-subtitle">Pairwise Pearson correlations across ${formatNumber(FILTERED_DATA.length)} observations</span>
            </div>
            <div class="card"><div class="chart-container large" id="corrMatrix"></div></div>
        </section>
        <div class="chart-grid">
            <section class="section">
                <div class="section-header">
                    <div class="section-marker"></div>
                    <h3 class="section-title">Sector Heatmap</h3>
                    <span class="section-subtitle">Top 15 sectors by observation count</span>
                </div>
                <div class="card"><div class="chart-container xlarge" id="sectorHeatmap"></div></div>
            </section>
            <section class="section">
                <div class="section-header">
                    <div class="section-marker"></div>
                    <h3 class="section-title">Day-of-Week Effects</h3>
                    <span class="section-subtitle">Average metrics by trading day</span>
                </div>
                <div class="card"><div class="chart-container xlarge" id="dowHeatmap"></div></div>
            </section>
        </div>
    `;

    // Correlation Matrix
    const metrics = [
        { key: 'capturedAlpha', label: 'Captured Alpha', fn: d => getCapturedAlpha(d) },
        { key: 'timingDiff', label: 'Timing Diff', fn: d => getTimingDiff(d) },
        { key: 'refGap', label: 'Ref Gap', fn: d => getRefGap(d) },
        { key: 'totalGap', label: 'Total Gap', fn: d => d.totalGap },
        { key: 'logNotional', label: 'Log Notional', fn: d => Math.log10(Math.max(d.notional, 1)) },
        { key: 'logVolume', label: 'Log Volume', fn: d => Math.log10(Math.max(d.volume, 1)) },
        { key: 'executions', label: 'Executions', fn: d => d.executions },
    ];

    const vectors = metrics.map(m => FILTERED_DATA.map(m.fn));
    const n = metrics.length;
    const corrData = [];
    for (let i = 0; i < n; i++) {
        corrData.push([]);
        for (let j = 0; j < n; j++) {
            corrData[i].push(parseFloat(pearsonCorr(vectors[i], vectors[j]).toFixed(3)));
        }
    }

    Plotly.newPlot('corrMatrix', [{
        z: corrData,
        x: metrics.map(m => m.label),
        y: metrics.map(m => m.label),
        type: 'heatmap',
        colorscale: [[0, '#4f8bf9'], [0.5, '#1a1f2e'], [1, '#f87171']],
        zmin: -1, zmax: 1,
        text: corrData.map(row => row.map(v => v.toFixed(2))),
        texttemplate: '%{text}',
        textfont: { size: 10, color: '#e8e9eb' },
        hovertemplate: '%{x} vs %{y}: %{z:.3f}<extra></extra>',
        showscale: true,
        colorbar: { title: 'r', titleside: 'right', tickfont: { color: '#9ca3b4' }, titlefont: { color: '#9ca3b4' } }
    }], plotlyDarkLayout({
        margin: { l: 100, r: 80, t: 15, b: 100 },
        xaxis: { tickangle: -35, tickfont: { size: 10 } },
        yaxis: { tickfont: { size: 10 } }
    }), plotlyConfig());

    // Sector Heatmap
    const sectorAgg = {};
    FILTERED_DATA.forEach(d => {
        if (!sectorAgg[d.sector]) sectorAgg[d.sector] = { tds: [], rgs: [], cas: [], nots: [], cons: 0, count: 0 };
        const s = sectorAgg[d.sector];
        s.tds.push(getTimingDiff(d)); s.rgs.push(getRefGap(d)); s.cas.push(getCapturedAlpha(d));
        s.nots.push(d.notional); if (d.dirConsistency) s.cons++; s.count++;
    });
    const topSectors = Object.entries(sectorAgg).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
    const sectorLabels = topSectors.map(s => s[0].length > 25 ? s[0].substring(0, 25) + '...' : s[0]);
    const sectorMetrics = ['Avg CA', 'Avg TD', 'Avg RG', 'Consistency', 'Obs'];
    const sectorZ = topSectors.map(([, s]) => [
        mean(s.cas), mean(s.tds), mean(s.rgs), s.cons / s.count * 100, s.count
    ]);

    // Normalize each column for color scale
    const normZ = sectorZ.map(row => [...row]);
    for (let col = 0; col < 5; col++) {
        const vals = sectorZ.map(r => r[col]);
        const mn = Math.min(...vals), mx = Math.max(...vals);
        const rng = mx - mn || 1;
        normZ.forEach((row, i) => { row[col] = (sectorZ[i][col] - mn) / rng; });
    }

    Plotly.newPlot('sectorHeatmap', [{
        z: normZ,
        x: sectorMetrics,
        y: sectorLabels,
        type: 'heatmap',
        colorscale: [[0, '#f87171'], [0.5, '#1a1f2e'], [1, '#34d399']],
        text: sectorZ.map(row => row.map((v, i) => i < 3 ? v.toFixed(1) + ' bps' : i === 3 ? v.toFixed(1) + '%' : v.toFixed(0))),
        texttemplate: '%{text}',
        textfont: { size: 9, color: '#e8e9eb' },
        hovertemplate: '%{y}<br>%{x}: %{text}<extra></extra>',
        showscale: false
    }], plotlyDarkLayout({
        margin: { l: 180, r: 20, t: 10, b: 50 },
        yaxis: { tickfont: { size: 10 }, autorange: 'reversed' },
        xaxis: { tickfont: { size: 10 }, side: 'bottom' }
    }), plotlyConfig());

    // Day-of-week heatmap
    const dowNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const dowAgg = { 0: { cas: [], tds: [], rgs: [], cons: 0, n: 0 }, 1: { cas: [], tds: [], rgs: [], cons: 0, n: 0 },
        2: { cas: [], tds: [], rgs: [], cons: 0, n: 0 }, 3: { cas: [], tds: [], rgs: [], cons: 0, n: 0 },
        4: { cas: [], tds: [], rgs: [], cons: 0, n: 0 } };
    FILTERED_DATA.forEach(d => {
        const dow = new Date(d.date + 'T12:00:00').getDay();
        const adjDow = dow === 0 ? 6 : dow - 1; // 0=Mon
        if (adjDow >= 0 && adjDow <= 4) {
            dowAgg[adjDow].cas.push(getCapturedAlpha(d));
            dowAgg[adjDow].tds.push(getTimingDiff(d));
            dowAgg[adjDow].rgs.push(getRefGap(d));
            if (d.dirConsistency) dowAgg[adjDow].cons++;
            dowAgg[adjDow].n++;
        }
    });

    const dowMetrics = ['Avg CA', 'Avg TD', 'Avg RG', 'Consistency%', 'Obs'];
    const dowZ = dowNames.map((_, i) => {
        const a = dowAgg[i];
        return [mean(a.cas), mean(a.tds), mean(a.rgs), a.n > 0 ? a.cons / a.n * 100 : 0, a.n];
    });
    const dowNorm = dowZ.map(row => [...row]);
    for (let col = 0; col < 5; col++) {
        const vals = dowZ.map(r => r[col]);
        const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
        dowNorm.forEach((row, i) => { row[col] = (dowZ[i][col] - mn) / rng; });
    }

    Plotly.newPlot('dowHeatmap', [{
        z: dowNorm,
        x: dowMetrics,
        y: dowNames,
        type: 'heatmap',
        colorscale: [[0, '#f87171'], [0.5, '#1a1f2e'], [1, '#34d399']],
        text: dowZ.map(row => row.map((v, i) => i < 3 ? v.toFixed(1) + ' bps' : i === 3 ? v.toFixed(1) + '%' : v.toFixed(0))),
        texttemplate: '%{text}',
        textfont: { size: 11, color: '#e8e9eb' },
        hovertemplate: '%{y}<br>%{x}: %{text}<extra></extra>',
        showscale: false
    }], plotlyDarkLayout({
        margin: { l: 50, r: 20, t: 10, b: 50 },
        yaxis: { tickfont: { size: 12 }, autorange: 'reversed' }
    }), plotlyConfig());
}

// ============================================================================
// TAB 9: RISK ANALYTICS
// ============================================================================

function renderRiskTab() {
    const container = document.getElementById('tab-risk');
    const caVals = FILTERED_DATA.map(d => getCapturedAlpha(d));
    const tdVals = FILTERED_DATA.map(d => getTimingDiff(d));
    const rgVals = FILTERED_DATA.map(d => getRefGap(d));

    const var95 = percentile(caVals, 5);
    const var99 = percentile(caVals, 1);
    const cvar95 = mean(caVals.filter(v => v <= var95));
    const maxLoss = Math.min(...caVals);
    const sk = skewness(caVals);
    const ku = kurtosis(caVals);

    container.innerHTML = `
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Tail Risk Metrics</h3>
                <span class="section-subtitle">Based on ${formatNumber(FILTERED_DATA.length)} observations</span>
            </div>
            <div class="metrics-grid" style="grid-template-columns:repeat(6,1fr);">
                <div class="risk-card">
                    <div class="risk-value negative">${formatBps(var95)}</div>
                    <div class="risk-label">VaR (95%)</div>
                    <div class="risk-sublabel">5th percentile</div>
                </div>
                <div class="risk-card">
                    <div class="risk-value negative">${formatBps(var99)}</div>
                    <div class="risk-label">VaR (99%)</div>
                    <div class="risk-sublabel">1st percentile</div>
                </div>
                <div class="risk-card">
                    <div class="risk-value negative">${formatBps(cvar95)}</div>
                    <div class="risk-label">CVaR / ES</div>
                    <div class="risk-sublabel">Expected shortfall</div>
                </div>
                <div class="risk-card">
                    <div class="risk-value negative">${formatBps(maxLoss)}</div>
                    <div class="risk-label">Max Loss</div>
                    <div class="risk-sublabel">Worst observation</div>
                </div>
                <div class="risk-card">
                    <div class="risk-value" style="color:var(--accent);">${sk.toFixed(2)}</div>
                    <div class="risk-label">Skewness</div>
                    <div class="risk-sublabel">${sk > 0 ? 'Right-tailed' : 'Left-tailed'}</div>
                </div>
                <div class="risk-card">
                    <div class="risk-value" style="color:var(--accent);">${ku.toFixed(2)}</div>
                    <div class="risk-label">Kurtosis</div>
                    <div class="risk-sublabel">${ku > 0 ? 'Fat tails' : 'Thin tails'}</div>
                </div>
            </div>
        </section>
        <div class="chart-grid">
            <section class="section">
                <div class="section-header">
                    <div class="section-marker"></div>
                    <h3 class="section-title">Captured Alpha Distribution</h3>
                </div>
                <div class="card"><div class="chart-container large" id="riskCaDist"></div></div>
            </section>
            <section class="section">
                <div class="section-header">
                    <div class="section-marker"></div>
                    <h3 class="section-title">Concentration Risk (Lorenz Curve)</h3>
                </div>
                <div class="card"><div class="chart-container large" id="riskLorenz"></div></div>
            </section>
        </div>
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Risk-Adjusted Sector Analysis</h3>
            </div>
            <div class="table-container">
                <div class="table-scroll"><table>
                    <thead><tr>
                        <th>Sector</th><th>Obs</th><th>Avg CA</th><th>Std Dev</th>
                        <th>Sharpe-Like</th><th>VaR 95%</th><th>Consistency</th>
                    </tr></thead>
                    <tbody id="riskSectorTable"></tbody>
                </table></div>
            </div>
        </section>
    `;

    // CA Distribution
    Plotly.newPlot('riskCaDist', [{
        x: caVals, type: 'histogram', nbinsx: 80,
        marker: { color: 'rgba(201,162,39,0.6)', line: { color: '#c9a227', width: 0.5 } },
        hovertemplate: 'Range: %{x:.0f} bps<br>Count: %{y}<extra></extra>'
    }, {
        x: [mean(caVals), mean(caVals)], y: [0, FILTERED_DATA.length * 0.05],
        mode: 'lines', type: 'scatter', name: 'Mean',
        line: { color: '#4f8bf9', width: 2, dash: 'dash' }
    }, {
        x: [var95, var95], y: [0, FILTERED_DATA.length * 0.05],
        mode: 'lines', type: 'scatter', name: 'VaR 95%',
        line: { color: '#f87171', width: 2, dash: 'dot' }
    }], plotlyDarkLayout({
        xaxis: { title: 'Captured Alpha (bps)', gridcolor: 'rgba(156,163,180,0.08)' },
        yaxis: { title: 'Frequency', gridcolor: 'rgba(156,163,180,0.08)' },
        legend: { font: { size: 10 }, x: 0.75, y: 0.95 },
        bargap: 0.02,
        margin: { l: 55, r: 20, t: 15, b: 50 }
    }), plotlyConfig());

    // Lorenz Curve
    const sortedNot = [...FILTERED_DATA].sort((a, b) => a.notional - b.notional);
    const totalNot = sortedNot.reduce((s, d) => s + d.notional, 0);
    let cumObs = [], cumNot = [], runNot = 0;
    sortedNot.forEach((d, i) => {
        runNot += d.notional;
        cumObs.push((i + 1) / sortedNot.length * 100);
        cumNot.push(runNot / totalNot * 100);
    });
    // Gini coefficient
    const gini = 1 - 2 * cumNot.reduce((s, v, i) => s + v / cumNot.length, 0) / 100;
    // Top 10 concentration
    const top10Pct = FILTERED_DATA.sort((a, b) => b.notional - a.notional)
        .slice(0, Math.ceil(FILTERED_DATA.length * 0.1))
        .reduce((s, d) => s + d.notional, 0) / totalNot * 100;

    Plotly.newPlot('riskLorenz', [{
        x: cumObs, y: cumNot, type: 'scatter', mode: 'lines',
        name: 'Lorenz Curve', line: { color: '#c9a227', width: 2 },
        fill: 'tozeroy', fillcolor: 'rgba(201,162,39,0.08)'
    }, {
        x: [0, 100], y: [0, 100], type: 'scatter', mode: 'lines',
        name: 'Perfect Equality', line: { color: '#4f8bf9', width: 1, dash: 'dash' }
    }], plotlyDarkLayout({
        xaxis: { title: '% of Observations (cumulative)', range: [0, 100] },
        yaxis: { title: '% of Notional (cumulative)', range: [0, 100] },
        legend: { font: { size: 10 }, x: 0.05, y: 0.95 },
        annotations: [{
            x: 50, y: 30, text: `Gini: ${gini.toFixed(3)}<br>Top 10%: ${top10Pct.toFixed(1)}% of notional`,
            showarrow: false, font: { color: '#c9a227', size: 12 }, align: 'center',
            bgcolor: 'rgba(21,26,38,0.8)', bordercolor: 'rgba(201,162,39,0.3)', borderwidth: 1, borderpad: 6
        }],
        margin: { l: 55, r: 20, t: 15, b: 50 }
    }), plotlyConfig());

    // Sector risk table
    const sectorRisk = {};
    FILTERED_DATA.forEach(d => {
        if (!sectorRisk[d.sector]) sectorRisk[d.sector] = { cas: [], cons: 0, n: 0 };
        sectorRisk[d.sector].cas.push(getCapturedAlpha(d));
        if (d.dirConsistency) sectorRisk[d.sector].cons++;
        sectorRisk[d.sector].n++;
    });
    const sectorRows = Object.entries(sectorRisk)
        .filter(([, s]) => s.n >= 10)
        .map(([name, s]) => ({
            name, n: s.n, avg: mean(s.cas), std: stdDev(s.cas),
            sharpe: stdDev(s.cas) > 0 ? mean(s.cas) / stdDev(s.cas) : 0,
            var95: percentile(s.cas, 5),
            consistency: s.cons / s.n * 100
        }))
        .sort((a, b) => b.sharpe - a.sharpe);

    document.getElementById('riskSectorTable').innerHTML = sectorRows.slice(0, 25).map(s => `
        <tr>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${s.name}">${s.name.substring(0, 25)}</td>
            <td>${formatNumber(s.n)}</td>
            <td class="mono ${getValueClass(s.avg)}">${formatBps(s.avg, true)}</td>
            <td class="mono">${s.std.toFixed(1)}</td>
            <td class="mono ${getValueClass(s.sharpe)}" style="font-weight:600;">${s.sharpe.toFixed(3)}</td>
            <td class="mono negative">${formatBps(s.var95)}</td>
            <td class="positive">${formatPercent(s.consistency)}</td>
        </tr>
    `).join('');
}

// ============================================================================
// TAB 10: TIME SERIES REGIMES
// ============================================================================

function renderTimeSeriesTab() {
    const container = document.getElementById('tab-timeseries');
    const ds = META.dailySummary;
    if (!ds) {
        container.innerHTML = '<div class="card" style="padding:3rem;text-align:center;color:var(--text-muted);">Daily summary data not available. Regenerate data.json with updated pipeline.</div>';
        return;
    }

    container.innerHTML = `
        <div class="analytics-controls">
            <div class="control-group">
                <label>Rolling Window</label>
                <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="3" max="20" value="${REGIME_STATE.window}"
                           id="regimeWindow" oninput="document.getElementById('regimeWinVal').textContent=this.value">
                    <span class="range-value" id="regimeWinVal">${REGIME_STATE.window}</span>
                    <span style="font-size:0.72rem;color:var(--text-muted);">days</span>
                </div>
            </div>
            <div class="control-group">
                <label>&nbsp;</label>
                <button class="btn-action" onclick="updateTimeSeries()">
                    <i class="fas fa-sync-alt"></i> Update
                </button>
            </div>
        </div>
        <section class="section">
            <div class="section-header"><div class="section-marker"></div>
                <h3 class="section-title">Rolling Captured Alpha with Regime Detection</h3>
            </div>
            <div class="card"><div class="chart-container xlarge" id="regimeChart"></div></div>
        </section>
        <div class="metrics-grid" id="regimeMetrics" style="grid-template-columns:repeat(4,1fr);"></div>
        <div class="chart-grid">
            <section class="section">
                <div class="section-header"><div class="section-marker"></div>
                    <h3 class="section-title">Volatility Clustering</h3>
                </div>
                <div class="card"><div class="chart-container" id="volChart"></div></div>
            </section>
            <section class="section">
                <div class="section-header"><div class="section-marker"></div>
                    <h3 class="section-title">Day-of-Week Performance</h3>
                </div>
                <div class="card"><div class="chart-container" id="dowChart"></div></div>
            </section>
        </div>
    `;
    updateTimeSeries();
}

function updateTimeSeries() {
    REGIME_STATE.window = parseInt(document.getElementById('regimeWindow')?.value || REGIME_STATE.window);
    const ds = META.dailySummary;
    const dates = LOOKUP.dates;
    const w = REGIME_STATE.window;

    const avgCas = dates.map(d => ds[d]?.avgCa || 0);
    const stds = dates.map(d => ds[d]?.stdTd || 0);
    const labels = dates.map(d => d.substring(5));

    // Rolling average
    const rolling = avgCas.map((_, i) => {
        if (i < w - 1) return null;
        return mean(avgCas.slice(i - w + 1, i + 1));
    });

    // Regime detection
    const regimes = rolling.map((v, i) => {
        if (v === null) return 'none';
        // Check last 3 values
        const recent = rolling.slice(Math.max(0, i - 2), i + 1).filter(x => x !== null);
        if (recent.length >= 3 && recent.every(x => x > 0)) return 'up';
        if (recent.length >= 3 && recent.every(x => x < 0)) return 'down';
        return 'transition';
    });

    // Regime summary
    let upDays = regimes.filter(r => r === 'up').length;
    let downDays = regimes.filter(r => r === 'down').length;
    let transDays = regimes.filter(r => r === 'transition').length;
    const upAvg = mean(avgCas.filter((_, i) => regimes[i] === 'up'));
    const downAvg = mean(avgCas.filter((_, i) => regimes[i] === 'down'));

    document.getElementById('regimeMetrics').innerHTML = `
        <div class="risk-card regime-up"><div class="risk-value positive">${upDays}</div><div class="risk-label">UP Regime Days</div><div class="risk-sublabel">Avg CA: ${formatBps(upAvg, true)}</div></div>
        <div class="risk-card regime-down"><div class="risk-value negative">${downDays}</div><div class="risk-label">DOWN Regime Days</div><div class="risk-sublabel">Avg CA: ${formatBps(downAvg, true)}</div></div>
        <div class="risk-card"><div class="risk-value" style="color:var(--accent);">${transDays}</div><div class="risk-label">Transition Days</div></div>
        <div class="risk-card"><div class="risk-value" style="color:var(--accent-blue);">${w}d</div><div class="risk-label">Window Size</div></div>
    `;

    // Gap annotations
    const gapShapes = (META.dateGaps || []).map(g => {
        const fromIdx = dates.indexOf(g.from);
        return { type: 'rect', xref: 'x', yref: 'paper', x0: fromIdx + 0.3, x1: fromIdx + 0.7, y0: 0, y1: 1,
            fillcolor: 'rgba(201,162,39,0.08)', line: { color: 'rgba(201,162,39,0.4)', width: 1, dash: 'dot' } };
    });
    const gapAnnotations = (META.dateGaps || []).map(g => ({
        x: dates.indexOf(g.from) + 0.5, y: 1.06, yref: 'paper', xref: 'x',
        text: g.label, showarrow: false, font: { size: 8, color: '#c9a227' }
    }));

    // Regime background shapes
    const regimeShapes = [];
    let currentRegime = regimes[0], startIdx = 0;
    for (let i = 1; i <= regimes.length; i++) {
        if (i === regimes.length || regimes[i] !== currentRegime) {
            if (currentRegime === 'up' || currentRegime === 'down') {
                regimeShapes.push({
                    type: 'rect', xref: 'x', yref: 'paper', x0: startIdx - 0.5, x1: i - 0.5, y0: 0, y1: 1,
                    fillcolor: currentRegime === 'up' ? 'rgba(52,211,153,0.04)' : 'rgba(248,113,113,0.04)',
                    line: { width: 0 }
                });
            }
            if (i < regimes.length) { currentRegime = regimes[i]; startIdx = i; }
        }
    }

    Plotly.newPlot('regimeChart', [
        { x: labels, y: avgCas, type: 'bar', name: 'Daily Avg CA',
          marker: { color: avgCas.map(v => v >= 0 ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)') } },
        { x: labels, y: rolling, type: 'scatter', mode: 'lines', name: `${w}-Day Rolling`,
          line: { color: '#c9a227', width: 2.5 } },
        { x: labels, y: Array(labels.length).fill(0), type: 'scatter', mode: 'lines', name: 'Zero',
          line: { color: 'rgba(156,163,180,0.2)', width: 1, dash: 'dot' }, showlegend: false }
    ], plotlyDarkLayout({
        xaxis: { title: null, tickangle: -45, tickfont: { size: 9 } },
        yaxis: { title: 'Captured Alpha (bps)' },
        legend: { font: { size: 10 }, orientation: 'h', y: 1.08 },
        shapes: [...gapShapes, ...regimeShapes],
        annotations: gapAnnotations,
        bargap: 0.15,
        margin: { l: 55, r: 20, t: 50, b: 60 }
    }), plotlyConfig());

    // Volatility chart
    const rollingStd = stds.map((_, i) => {
        if (i < w - 1) return null;
        return mean(stds.slice(i - w + 1, i + 1));
    });
    const ctx = document.createElement('canvas');
    document.getElementById('volChart').innerHTML = '';
    document.getElementById('volChart').appendChild(ctx);
    chartInstances.volChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Daily Std Dev', data: stds,
                borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,0.08)', fill: true,
                tension: 0.3, pointRadius: 2, borderWidth: 1.5
            }, {
                label: `${w}-Day Avg`, data: rollingStd,
                borderColor: '#c9a227', borderWidth: 2, borderDash: [5, 5],
                fill: false, tension: 0.3, pointRadius: 0
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { color: '#9ca3b4', boxWidth: 12 } } },
            scales: {
                y: { grid: { color: 'rgba(156,163,180,0.08)' }, ticks: { color: '#6b7280' }, title: { display: true, text: 'Std Dev (bps)', color: '#6b7280' } },
                x: { grid: { display: false }, ticks: { color: '#6b7280', maxRotation: 45, font: { size: 9 } } }
            }
        }
    });

    // Day-of-week bar chart
    const dowNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const dowBuckets = [[], [], [], [], []];
    FILTERED_DATA.forEach(d => {
        const dow = new Date(d.date + 'T12:00:00').getDay();
        if (dow >= 1 && dow <= 5) dowBuckets[dow - 1].push(getCapturedAlpha(d));
    });
    const ctx2 = document.createElement('canvas');
    document.getElementById('dowChart').innerHTML = '';
    document.getElementById('dowChart').appendChild(ctx2);
    chartInstances.dowChart = new Chart(ctx2, {
        type: 'bar',
        data: {
            labels: dowNames,
            datasets: [{
                label: 'Avg Captured Alpha',
                data: dowBuckets.map(b => mean(b)),
                backgroundColor: dowBuckets.map(b => mean(b) >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)'),
                borderColor: dowBuckets.map(b => mean(b) >= 0 ? '#34d399' : '#f87171'),
                borderWidth: 1, borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { grid: { color: 'rgba(156,163,180,0.08)' }, ticks: { color: '#6b7280', callback: v => v + ' bps' } },
                x: { grid: { display: false }, ticks: { color: '#9ca3b4', font: { size: 12 } } }
            }
        }
    });
}

// ============================================================================
// TAB 11: SYMBOL SCREENER
// ============================================================================

function renderScreenerTab() {
    const container = document.getElementById('tab-screener');
    container.innerHTML = `
        <div class="analytics-controls">
            <div class="control-group">
                <label>Min Observations</label>
                <div style="display:flex;align-items:center;gap:8px;">
                    <input type="range" min="1" max="50" value="${SCREENER_STATE.filters.minObs}"
                           id="screenerMinObs" oninput="document.getElementById('screenerMinObsVal').textContent=this.value">
                    <span class="range-value" id="screenerMinObsVal">${SCREENER_STATE.filters.minObs}</span>
                </div>
            </div>
            <div class="filter-group">
                <label>Asset Type</label>
                <select id="screenerAssetType">
                    <option value="all">All</option>
                    <option value="Stock">Stocks</option>
                    <option value="ETF">ETFs</option>
                </select>
            </div>
            <div class="control-group">
                <label>&nbsp;</label>
                <button class="btn-action" onclick="runScreener()">
                    <i class="fas fa-search"></i> Screen
                </button>
            </div>
            <div class="control-group">
                <label>&nbsp;</label>
                <button class="btn-export" onclick="exportScreenerCSV()">
                    <i class="fas fa-download"></i> Export CSV
                </button>
            </div>
        </div>
        <div class="result-count" id="screenerCount"></div>
        <div class="table-container">
            <div class="table-scroll" style="max-height:550px;">
                <table>
                    <thead><tr>
                        <th style="width:30px;"></th>
                        <th class="sortable" onclick="sortScreener('symbol')">Symbol</th>
                        <th>Company</th>
                        <th>Type</th>
                        <th class="sortable" onclick="sortScreener('obs')">Obs</th>
                        <th class="sortable" onclick="sortScreener('avgNotional')">Avg Notional</th>
                        <th class="sortable" onclick="sortScreener('avgCapturedAlpha')">Avg CA</th>
                        <th class="sortable" onclick="sortScreener('medianCa')">Median CA</th>
                        <th class="sortable" onclick="sortScreener('stdCa')">Std Dev</th>
                        <th class="sortable" onclick="sortScreener('consistency')">Consistency</th>
                        <th class="sortable" onclick="sortScreener('avgRg')">Avg RG</th>
                    </tr></thead>
                    <tbody id="screenerTableBody"></tbody>
                </table>
            </div>
        </div>
        <div id="screenerComparison" style="margin-top:1.5rem;"></div>
    `;
    runScreener();
}

let screenerData = [];

function computeSymbolAggregates() {
    const map = {};
    FILTERED_DATA.forEach(d => {
        if (!map[d.symbol]) {
            map[d.symbol] = { symbol: d.symbol, company: d.company, assetType: d.assetType,
                sector: d.sector, cas: [], rgs: [], nots: [], cons: 0, up: 0, dates: [] };
        }
        const s = map[d.symbol];
        s.cas.push(getCapturedAlpha(d)); s.rgs.push(getRefGap(d));
        s.nots.push(d.notional); s.dates.push(d.date);
        if (d.dirConsistency) s.cons++;
        if (d.gapDirection === 'UP') s.up++;
    });
    return Object.values(map).map(s => ({
        ...s, obs: s.cas.length,
        avgCapturedAlpha: mean(s.cas), medianCa: median(s.cas), stdCa: stdDev(s.cas),
        avgRg: mean(s.rgs), avgNotional: mean(s.nots),
        totalNotional: s.nots.reduce((a, b) => a + b, 0),
        consistency: s.cas.length > 0 ? s.cons / s.cas.length * 100 : 0,
        upRate: s.cas.length > 0 ? s.up / s.cas.length * 100 : 0,
    }));
}

function runScreener() {
    const minObs = parseInt(document.getElementById('screenerMinObs')?.value || SCREENER_STATE.filters.minObs);
    const assetType = document.getElementById('screenerAssetType')?.value || 'all';
    SCREENER_STATE.filters.minObs = minObs;

    screenerData = computeSymbolAggregates()
        .filter(s => s.obs >= minObs)
        .filter(s => assetType === 'all' || s.assetType === assetType);

    // Sort
    const { column, ascending } = SCREENER_STATE.sort;
    screenerData.sort((a, b) => {
        let av = a[column], bv = b[column];
        if (typeof av === 'string') return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        return ascending ? av - bv : bv - av;
    });

    document.getElementById('screenerCount').innerHTML =
        `<strong>${formatNumber(screenerData.length)}</strong> symbols (min ${minObs} observations)`;

    const start = (SCREENER_STATE.page - 1) * 25;
    const pageData = screenerData.slice(start, start + 25);

    document.getElementById('screenerTableBody').innerHTML = pageData.map(s => `
        <tr>
            <td><input type="checkbox" class="watchlist-check" ${SCREENER_STATE.watchlist.has(s.symbol) ? 'checked' : ''}
                onchange="toggleWatchlist('${s.symbol}')"></td>
            <td class="symbol">${s.symbol}</td>
            <td class="company" title="${s.company}">${s.company.substring(0, 22)}</td>
            <td>${s.assetType}</td>
            <td class="mono">${s.obs}</td>
            <td class="mono">${formatCurrency(s.avgNotional, true)}</td>
            <td class="mono ${getValueClass(s.avgCapturedAlpha)}">${formatBps(s.avgCapturedAlpha, true)}</td>
            <td class="mono ${getValueClass(s.medianCa)}">${formatBps(s.medianCa, true)}</td>
            <td class="mono">${s.stdCa.toFixed(1)}</td>
            <td class="positive">${formatPercent(s.consistency)}</td>
            <td class="mono ${getValueClass(s.avgRg)}">${formatBps(s.avgRg, true)}</td>
        </tr>
    `).join('');

    renderWatchlistComparison();
}

function sortScreener(col) {
    if (SCREENER_STATE.sort.column === col) {
        SCREENER_STATE.sort.ascending = !SCREENER_STATE.sort.ascending;
    } else {
        SCREENER_STATE.sort.column = col;
        SCREENER_STATE.sort.ascending = false;
    }
    SCREENER_STATE.page = 1;
    runScreener();
}

function toggleWatchlist(symbol) {
    if (SCREENER_STATE.watchlist.has(symbol)) {
        SCREENER_STATE.watchlist.delete(symbol);
    } else {
        if (SCREENER_STATE.watchlist.size >= 6) return; // max 6
        SCREENER_STATE.watchlist.add(symbol);
    }
    renderWatchlistComparison();
}

function renderWatchlistComparison() {
    const compDiv = document.getElementById('screenerComparison');
    if (SCREENER_STATE.watchlist.size < 2) {
        compDiv.innerHTML = SCREENER_STATE.watchlist.size === 0 ?
            '' : '<div class="card" style="padding:1rem;text-align:center;color:var(--text-muted);font-size:0.82rem;">Select 2+ symbols to compare</div>';
        return;
    }
    const watchSymbols = [...SCREENER_STATE.watchlist];
    const colors = CLUSTER_COLORS;

    // Build per-date traces
    const traces = watchSymbols.map((sym, i) => {
        const symData = FILTERED_DATA.filter(d => d.symbol === sym).sort((a, b) => a.date.localeCompare(b.date));
        return {
            x: symData.map(d => d.date.substring(5)),
            y: symData.map(d => getCapturedAlpha(d)),
            type: 'scatter', mode: 'lines+markers',
            name: sym, line: { color: colors[i % colors.length], width: 2 },
            marker: { size: 5 }
        };
    });

    compDiv.innerHTML = `
        <section class="section">
            <div class="section-header"><div class="section-marker"></div>
                <h3 class="section-title">Watchlist Comparison</h3>
                <span class="section-subtitle">${watchSymbols.join(', ')}</span>
            </div>
            <div class="card"><div class="chart-container" id="watchlistChart"></div></div>
        </section>
    `;

    Plotly.newPlot('watchlistChart', traces, plotlyDarkLayout({
        xaxis: { title: null, tickangle: -45, tickfont: { size: 9 } },
        yaxis: { title: 'Captured Alpha (bps)' },
        legend: { font: { size: 10 }, orientation: 'h', y: 1.1 },
        margin: { l: 55, r: 20, t: 30, b: 60 }
    }), plotlyConfig());
}

function exportScreenerCSV() {
    if (!screenerData.length) return;
    const headers = ['Symbol', 'Company', 'Type', 'Sector', 'Observations', 'Avg Notional', 'Avg Captured Alpha (bps)',
        'Median CA (bps)', 'Std Dev', 'Avg Ref Gap (bps)', 'Consistency %'];
    const rows = screenerData.map(s => [
        s.symbol, `"${s.company.replace(/"/g, '""')}"`, s.assetType, `"${s.sector.replace(/"/g, '""')}"`,
        s.obs, s.avgNotional.toFixed(2), s.avgCapturedAlpha.toFixed(2), s.medianCa.toFixed(2),
        s.stdCa.toFixed(2), s.avgRg.toFixed(2), s.consistency.toFixed(1)
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sapinover_screener_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================================
// TAB 11: ASIA SLEEPS -- Lunar New Year 2026 Geographic Analysis
// ============================================================================

function renderAsiaSleepsTab() {
    const container = document.getElementById('tab-asiasleeps');

    // Hardcoded research data from "When Asia Sleeps" (Feb 2026)
    const volumeData = {
        dates: ['Feb 5', 'Feb 6', 'Feb 9', 'Feb 10', 'Feb 11', 'Feb 17', 'Feb 18', 'Feb 19', 'Feb 20'],
        combined: [6.10, 6.10, 4.96, 2.40, 2.44, 3.18, 1.76, 1.74, 1.77],
        venueA: [4.85, 4.66, 4.12, 2.03, 2.01, 2.70, 1.53, 1.44, 1.44],
        vsBaseline: [0, 0, -19, -61, -60, -48, -71, -71, -71]
    };

    const geoAttribution = [
        { source: 'US Domestic Retail', share: 35, notional: '$500\u2013700M', color: '#4f8bf9' },
        { source: 'Japan', share: 25, notional: '$300\u2013500M', color: '#c9a227' },
        { source: 'Market Makers', share: 12, notional: '$170\u2013250M', color: '#34d399' },
        { source: 'Australia / Canada', share: 10, notional: '$100\u2013200M', color: '#a78bfa' },
        { source: 'Europe / Middle East', share: 10, notional: '$50\u2013120M', color: '#f87171' },
        { source: 'Residual Asian', share: 8, notional: '$50\u2013150M', color: '#fbbf24' }
    ];

    const sectorAllocation = [
        { sector: 'Tech / Semiconductors', notional: 1017, pct: 18.1, names: 'NVDA, MU, SNDK, AMD, AVGO, SOXL' },
        { sector: 'Leveraged / Inverse ETFs', notional: 935, pct: 16.6, names: 'TQQQ, SQQQ, SOXL, AGQ, ZSL' },
        { sector: 'Precious Metals', notional: 913, pct: 16.3, names: 'SLV, GLD, AGQ, ZSL, UGL, NEM' },
        { sector: 'Mega-Cap Technology', notional: 722, pct: 12.9, names: 'TSLA, GOOGL, MSFT, AMZN, META, PLTR' },
        { sector: 'Index ETFs', notional: 587, pct: 10.4, names: 'QQQ, SPY, IWM' },
        { sector: 'Crypto-Linked', notional: 115, pct: 2.0, names: 'MSTR, IBIT, COIN' },
        { sector: 'China / Asia-Linked', notional: 113, pct: 2.0, names: 'BABA, BIDU, EWY' },
        { sector: 'Financials', notional: 37, pct: 0.7, names: 'HOOD, JPM, BAC' }
    ];

    // Exchange closure calendar: 1=open, 0=closed, 0.5=half-day
    const exchanges = [
        { name: 'China',       status: [1,1,1,1,1,1,0,0,0,0,0,0,1] },
        { name: 'S. Korea',    status: [1,1,1,1,1,1,0,0,0,1,1,1,1] },
        { name: 'Taiwan',      status: [1,1,1,1,1,1,0,0,0,0,0,1,1] },
        { name: 'Hong Kong',   status: [1,1,1,1,1,1,0.5,0,0,0,1,1,1] },
        { name: 'Japan',       status: [1,1,1,1,0,1,1,1,1,1,1,0,1] },
        { name: 'Singapore',   status: [1,1,1,1,1,1,0.5,0,0,1,1,1,1] },
        { name: 'Vietnam',     status: [1,1,1,1,1,1,0,0,0,0,0,1,1] },
        { name: 'Indonesia',   status: [1,1,1,1,1,1,0,0,1,1,1,1,1] },
        { name: 'Malaysia',    status: [1,1,1,1,1,1,1,0,0,1,1,1,1] },
        { name: 'Philippines', status: [1,1,1,1,1,1,1,0,1,1,1,1,1] }
    ];
    const calDates = ['5','6','9','10','11','13','16','17','18','19','20','23','24'];

    const holidayImpact = [
        { holiday: 'Lunar New Year', duration: '5\u20138 days', markets: 'China, Korea, Taiwan, HK, SG, VN, ID, MY, PH', impact: 'Severe', decline: '60\u201375%' },
        { holiday: 'Golden Week (Japan)', duration: '4\u20135 days', markets: 'Japan', impact: 'Moderate', decline: '10\u201315%' },
        { holiday: 'Golden Week (China)', duration: '5\u20137 days', markets: 'China', impact: 'Moderate', decline: '15\u201325%' },
        { holiday: 'Chuseok (Korea)', duration: '3 days', markets: 'South Korea', impact: 'Moderate', decline: '15\u201325%' },
        { holiday: 'Mid-Autumn Festival', duration: '1\u20132 days', markets: 'China, HK, Taiwan, VN', impact: 'Mild', decline: '5\u201310%' }
    ];

    // Sector shift: pre-holiday (Feb 3/5/6) vs during-holiday (Feb 17-20), from parquet
    const sectorShift = [
        { sector: 'Commodities Focused', prePct: 17.0, durPct: 12.0, shift: -4.9, preM: 2338.5, durM: 849.7 },
        { sector: 'Technology', prePct: 29.3, durPct: 26.3, shift: -3.0, preM: 4037.8, durM: 1856.4 },
        { sector: 'Lev. Commodities', prePct: 5.2, durPct: 3.9, shift: -1.3, preM: 719.0, durM: 277.3 },
        { sector: 'Financial Services', prePct: 3.8, durPct: 2.8, shift: -1.0, preM: 525.3, durM: 201.1 },
        { sector: 'Consumer Cyclical', prePct: 7.5, durPct: 6.7, shift: -0.8, preM: 1040.9, durM: 475.4 },
        { sector: 'Digital Assets', prePct: 3.0, durPct: 2.2, shift: -0.8, preM: 417.4, durM: 154.5 },
        { sector: 'Comm. Services', prePct: 5.8, durPct: 5.7, shift: -0.1, preM: 797.2, durM: 402.7 },
        { sector: 'Basic Materials', prePct: 1.2, durPct: 1.2, shift: 0.0, preM: 167.3, durM: 84.4 },
        { sector: 'Healthcare', prePct: 1.0, durPct: 1.4, shift: 0.4, preM: 132.4, durM: 99.2 },
        { sector: 'Industrials', prePct: 1.5, durPct: 2.0, shift: 0.5, preM: 212.0, durM: 144.2 },
        { sector: 'Inv. Commodities', prePct: 1.2, durPct: 1.7, shift: 0.5, preM: 168.0, durM: 118.1 },
        { sector: 'Large Blend (SPY)', prePct: 2.2, durPct: 3.4, shift: 1.2, preM: 301.1, durM: 241.3 },
        { sector: 'Inverse Equity', prePct: 2.7, durPct: 4.3, shift: 1.5, preM: 376.8, durM: 301.4 },
        { sector: 'Large Growth (QQQ)', prePct: 3.3, durPct: 6.2, shift: 2.9, preM: 458.4, durM: 439.9 },
        { sector: 'Leveraged Equity', prePct: 9.9, durPct: 13.3, shift: 3.4, preM: 1361.7, durM: 938.2 }
    ];

    // Asia-linked individual names: pre vs during holiday
    const asiaLinkedTickers = [
        { symbol: 'BABA', region: 'China', type: 'Stock', preM: 198.6, durM: 53.5, changePct: -73 },
        { symbol: 'BIDU', region: 'China', type: 'Stock', preM: 39.3, durM: 12.5, changePct: -68 },
        { symbol: 'EWY', region: 'Korea', type: 'ETF', preM: 25.7, durM: 26.4, changePct: 3 },
        { symbol: 'FXI', region: 'China', type: 'ETF', preM: 22.5, durM: 8.7, changePct: -61 },
        { symbol: 'PDD', region: 'China', type: 'Stock', preM: 19.9, durM: 7.2, changePct: -64 },
        { symbol: 'NIO', region: 'China', type: 'Stock', preM: 15.4, durM: 1.7, changePct: -89 },
        { symbol: 'JD', region: 'China', type: 'Stock', preM: 13.6, durM: 7.0, changePct: -49 },
        { symbol: 'KWEB', region: 'China', type: 'ETF', preM: 11.7, durM: 4.0, changePct: -66 },
        { symbol: 'XPEV', region: 'China', type: 'Stock', preM: 9.3, durM: 2.2, changePct: -76 },
        { symbol: 'LI', region: 'China', type: 'Stock', preM: 2.9, durM: 0.4, changePct: -86 },
        { symbol: 'ASHR', region: 'China', type: 'ETF', preM: 1.8, durM: 0.0, changePct: -100 },
        { symbol: 'INDA', region: 'India', type: 'ETF', preM: 1.8, durM: 0.2, changePct: -91 },
        { symbol: 'EWJ', region: 'Japan', type: 'ETF', preM: 1.1, durM: 3.4, changePct: 194 },
        { symbol: 'EEM', region: 'Broad EM', type: 'ETF', preM: 0.6, durM: 0.2, changePct: -60 },
        { symbol: 'EWT', region: 'Taiwan', type: 'ETF', preM: 0.1, durM: 0.1, changePct: 64 }
    ];

    container.innerHTML = `
        <!-- Hero Section -->
        <div class="hero asia-hero">
            <h2><i class="fas fa-moon" style="color:var(--accent-blue);margin-right:0.5rem;"></i> When Asia Sleeps, Overnight Volume Drops 72%</h2>
            <p class="hero-subtitle">Lunar New Year 2026: Geographic Anatomy of US Overnight Equity Flow</p>
            <div class="hero-stats">
                <div class="hero-stat">
                    <div class="hero-stat-value">$6.1B</div>
                    <div class="hero-stat-label">Pre-Holiday Baseline</div>
                    <div class="hero-stat-sub">Feb 5/6 average</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-value" style="color:#f87171;">$1.77B</div>
                    <div class="hero-stat-label">Holiday Trough</div>
                    <div class="hero-stat-sub">Feb 18\u201320 average</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-value" style="color:#c9a227;">~75%</div>
                    <div class="hero-stat-label">Implied Asia Share</div>
                    <div class="hero-stat-sub">of overnight flow</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-value" style="color:#4f8bf9;">9 of 10</div>
                    <div class="hero-stat-label">Markets Closed (Peak)</div>
                    <div class="hero-stat-sub">Feb 17, 2026</div>
                </div>
            </div>
        </div>

        <!-- Closure Calendar -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Asian Exchange Closure Calendar</h3>
                <span class="section-subtitle">February 2026 Lunar New Year period</span>
            </div>
            <div class="card" style="overflow-x:auto;">
                <table class="closure-calendar">
                    <thead>
                        <tr>
                            <th>Exchange</th>
                            ${calDates.map(d => `<th class="cal-date">Feb ${d}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${exchanges.map(ex => `
                            <tr>
                                <td class="exchange-name">${ex.name}</td>
                                ${ex.status.map(s =>
                                    s === 1 ? '<td class="cal-open">\u2713</td>' :
                                    s === 0 ? '<td class="cal-closed">\u2717</td>' :
                                    '<td class="cal-half">\u00BD</td>'
                                ).join('')}
                            </tr>
                        `).join('')}
                        <tr class="cal-summary-row">
                            <td class="exchange-name" style="font-weight:700;">Markets Closed</td>
                            ${calDates.map((_, i) => {
                                const closed = exchanges.reduce((sum, ex) => sum + (ex.status[i] < 1 ? 1 : 0), 0);
                                return `<td class="cal-count">${closed}</td>`;
                            }).join('')}
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <!-- Volume Trajectory -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Volume Trajectory</h3>
                <span class="section-subtitle">Three-venue consolidated overnight notional, Feb 5\u201320</span>
            </div>
            <div class="card"><div class="chart-container large" id="asiaVolumeChart"></div></div>
        </section>

        <!-- Geographic Attribution + Sector Allocation -->
        <div class="chart-grid">
            <section class="section">
                <div class="section-header">
                    <div class="section-marker"></div>
                    <h3 class="section-title">Geographic Attribution</h3>
                    <span class="section-subtitle">Who trades when Asia sleeps? ($1.7B residual)</span>
                </div>
                <div class="card"><div class="chart-container large" id="asiaGeoChart"></div></div>
            </section>
            <section class="section">
                <div class="section-header">
                    <div class="section-marker"></div>
                    <h3 class="section-title">Sector Allocation During Holiday</h3>
                    <span class="section-subtitle">Three-session aggregate (Feb 17/18/20)</span>
                </div>
                <div class="card"><div class="chart-container large" id="asiaSectorChart"></div></div>
            </section>
        </div>

        <!-- Holiday Impact Forecast Table -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Asian Holiday Calendar Impact</h3>
                <span class="section-subtitle">Projected overnight volume impact from recurring Asian holidays</span>
            </div>
            <div class="card" style="overflow-x:auto;">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Holiday</th>
                            <th>Typical Duration</th>
                            <th>Markets Closed</th>
                            <th>Expected Impact</th>
                            <th>Est. Decline</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${holidayImpact.map(h => `
                            <tr>
                                <td style="font-weight:600;color:var(--text-primary);">${h.holiday}</td>
                                <td>${h.duration}</td>
                                <td style="font-size:0.78rem;">${h.markets}</td>
                                <td><span class="impact-badge impact-${h.impact.toLowerCase()}">${h.impact}</span></td>
                                <td style="font-family:'JetBrains Mono';color:#f87171;">${h.decline}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </section>

        <!-- Key Findings -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Key Findings</h3>
            </div>
            <div class="insight-grid">
                <div class="insight-card">
                    <div class="insight-icon"><i class="fas fa-chart-line"></i></div>
                    <h4>Pre-Holiday Decay</h4>
                    <p>Volume began declining <strong>six days before</strong> the first Lunar New Year closure. Consolidated notional fell 61% from $6.1B to $2.4B by Feb 10, as Asian desks reduced overnight exposure ahead of extended closures.</p>
                </div>
                <div class="insight-card">
                    <div class="insight-icon" style="color:#34d399;"><i class="fas fa-layer-group"></i></div>
                    <h4>The $1.7B Floor</h4>
                    <p>A persistent <strong>$1.7 billion floor</strong> held through three consecutive sessions (Feb 18\u201320). This represents the non-Asian overnight demand base: US retail, Japanese investors, and market maker liquidity provision.</p>
                </div>
                <div class="insight-card">
                    <div class="insight-icon" style="color:#f87171;"><i class="fas fa-arrow-trend-up"></i></div>
                    <h4>BABA Case Study</h4>
                    <p>Alibaba notional surged from <strong>$1.8M to $41M</strong> (22x increase) when Hong Kong reopened on Feb 20. This single-name pattern mirrors the aggregate: when Asian participants return, their preferred names immediately reflect it.</p>
                </div>
            </div>
        </section>

        <!-- Sector Composition Shift -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Sector Composition Shift</h3>
                <span class="section-subtitle">Share of overnight notional: Pre-Holiday (Feb 3/5/6) vs During Holiday (Feb 17\u201320)</span>
            </div>
            <div class="card"><div class="chart-container xlarge" id="asiaSectorShiftChart"></div></div>
            <div class="card" style="margin-top:1rem; padding:0.75rem 1rem;">
                <p style="font-size:0.78rem; color:var(--text-muted); margin:0; line-height:1.6;">
                    <strong style="color:#f87171;">Red shift (left)</strong> = sector share contracted during holiday, suggesting Asia-dependent flow.
                    <strong style="color:#34d399;">Green shift (right)</strong> = sector share expanded, indicating US/domestic-driven demand.
                    Commodities Focused (\u22125.0pp) and Technology (\u22123.0pp) saw the largest declines. Leveraged Equity (+3.4pp)
                    and Large Growth (+2.9pp) expanded as domestic retail and market makers concentrated in high-beta ETFs.
                </p>
            </div>
        </section>

        <!-- Asia-Linked Symbols -->
        <section class="section">
            <div class="section-header">
                <div class="section-marker"></div>
                <h3 class="section-title">Asia-Linked Symbol Impact</h3>
                <span class="section-subtitle">Regional stocks and ETFs: notional change during Lunar New Year</span>
            </div>
            <div class="chart-grid">
                <div class="card"><div class="chart-container large" id="asiaTickerChart"></div></div>
                <div class="card" style="overflow-x:auto;">
                    <table class="data-table asia-ticker-table">
                        <thead>
                            <tr>
                                <th>Symbol</th>
                                <th>Region</th>
                                <th>Type</th>
                                <th style="text-align:right;">Pre ($M)</th>
                                <th style="text-align:right;">During ($M)</th>
                                <th style="text-align:right;">Change</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${asiaLinkedTickers.map(t => `
                                <tr>
                                    <td class="symbol">${t.symbol}</td>
                                    <td><span class="region-badge region-${t.region.toLowerCase().replace(/ /g,'')}">${t.region}</span></td>
                                    <td>${t.type}</td>
                                    <td style="text-align:right;font-family:'JetBrains Mono';">$${t.preM.toFixed(1)}</td>
                                    <td style="text-align:right;font-family:'JetBrains Mono';">$${t.durM.toFixed(1)}</td>
                                    <td style="text-align:right;font-family:'JetBrains Mono';font-weight:600;color:${t.changePct > 0 ? '#34d399' : '#f87171'};">
                                        ${t.changePct > 0 ? '+' : ''}${t.changePct}%
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="card" style="margin-top:1rem; padding:0.75rem 1rem;">
                <p style="font-size:0.78rem; color:var(--text-muted); margin:0; line-height:1.6;">
                    <strong>China-linked names collapsed 50\u2013100%</strong> as Chinese markets closed for 6 trading days.
                    NIO (\u221289%), ASHR (\u2212100%), and LI (\u221286%) were effectively untradeable.
                    <strong style="color:#c9a227;">Japan (EWJ) surged +194%</strong> as the only major Asian market open during Lunar New Year.
                    Korea (EWY) held flat, consistent with its quick 3-day closure and Feb 19 reopening.
                </p>
            </div>
        </section>

        <div class="disclaimer">
            <div class="disclaimer-title">Source</div>
            <p>
                Data sourced from three leading overnight Alternative Trading Systems. Asian market closure dates
                verified against exchange-published holiday calendars. Volume figures represent executed notional
                during overnight session windows (8 PM to 4 AM ET). Geographic attribution estimates derived from
                published CEO interviews, academic research, timezone-based volume analysis, and the August 2024
                Korean broker suspension natural experiment. Sector shift data computed from institutional-filtered
                ($50K+) BlueOcean ATS observations. Sapinover LLC, February 2026.
            </p>
        </div>
    `;

    // --- CHARTS ---

    // Volume Trajectory (Plotly)
    const volTrace = {
        x: volumeData.dates,
        y: volumeData.combined,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Combined Notional ($B)',
        line: { color: '#4f8bf9', width: 2.5 },
        marker: { size: 8, color: volumeData.combined.map(v => v < 2 ? '#f87171' : '#4f8bf9') },
        hovertemplate: '%{x}<br>$%{y:.2f}B<extra></extra>'
    };

    const volTraceA = {
        x: volumeData.dates,
        y: volumeData.venueA,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Venue A ($B)',
        line: { color: '#c9a227', width: 1.5, dash: 'dot' },
        marker: { size: 5, color: '#c9a227' },
        hovertemplate: '%{x}<br>$%{y:.2f}B<extra></extra>'
    };

    // Baseline reference line
    const baselineTrace = {
        x: volumeData.dates,
        y: Array(volumeData.dates.length).fill(6.10),
        type: 'scatter',
        mode: 'lines',
        name: 'Baseline ($6.1B)',
        line: { color: 'rgba(156,163,180,0.3)', width: 1, dash: 'dash' },
        hoverinfo: 'skip'
    };

    // Trough reference line
    const troughTrace = {
        x: volumeData.dates,
        y: Array(volumeData.dates.length).fill(1.77),
        type: 'scatter',
        mode: 'lines',
        name: 'Trough ($1.77B)',
        line: { color: 'rgba(248,113,113,0.3)', width: 1, dash: 'dash' },
        hoverinfo: 'skip'
    };

    Plotly.newPlot('asiaVolumeChart', [baselineTrace, troughTrace, volTrace, volTraceA], plotlyDarkLayout({
        margin: { l: 60, r: 20, t: 30, b: 50 },
        yaxis: { title: 'Notional ($B)', gridcolor: 'rgba(156,163,180,0.08)', rangemode: 'tozero' },
        xaxis: { tickangle: -30 },
        legend: { x: 0.02, y: 0.98, bgcolor: 'rgba(0,0,0,0.5)', font: { size: 10 } },
        annotations: [
            { x: 'Feb 10', y: 2.40, text: 'Pre-holiday<br>decay', showarrow: true, arrowhead: 2, ax: -40, ay: -30, font: { size: 10, color: '#c9a227' }, arrowcolor: '#c9a227' },
            { x: 'Feb 18', y: 1.76, text: 'Holiday<br>trough', showarrow: true, arrowhead: 2, ax: 40, ay: -35, font: { size: 10, color: '#f87171' }, arrowcolor: '#f87171' },
            { x: 'Feb 17', y: 3.18, text: 'Post-holiday<br>bounce', showarrow: true, arrowhead: 2, ax: -35, ay: -25, font: { size: 10, color: '#4f8bf9' }, arrowcolor: '#4f8bf9' }
        ],
        shapes: [{
            type: 'rect', x0: 'Feb 17', x1: 'Feb 20', y0: 0, y1: 7,
            fillcolor: 'rgba(248,113,113,0.05)', line: { width: 0 }
        }]
    }), plotlyConfig());

    // Geographic Attribution (Plotly donut)
    Plotly.newPlot('asiaGeoChart', [{
        labels: geoAttribution.map(g => g.source),
        values: geoAttribution.map(g => g.share),
        type: 'pie',
        hole: 0.55,
        marker: { colors: geoAttribution.map(g => g.color) },
        textinfo: 'label+percent',
        textposition: 'outside',
        textfont: { size: 10, color: '#e8e9eb' },
        hovertemplate: '<b>%{label}</b><br>%{percent}<br>Est: ' +
            geoAttribution.map(g => g.notional).join('|').split('|').map(n => n) +
            '<extra></extra>',
        customdata: geoAttribution.map(g => g.notional),
        hovertemplate: '<b>%{label}</b><br>%{percent}<br>Est: %{customdata}<extra></extra>'
    }], plotlyDarkLayout({
        margin: { l: 20, r: 20, t: 20, b: 20 },
        annotations: [{
            text: '<b>$1.7B</b><br>Residual',
            showarrow: false, font: { size: 14, color: '#e8e9eb' }
        }],
        showlegend: false
    }), plotlyConfig());

    // Sector Allocation (Plotly horizontal bar)
    const sectorsSorted = [...sectorAllocation].reverse();
    Plotly.newPlot('asiaSectorChart', [{
        y: sectorsSorted.map(s => s.sector),
        x: sectorsSorted.map(s => s.notional),
        type: 'bar',
        orientation: 'h',
        marker: {
            color: sectorsSorted.map(s => s.notional > 900 ? '#c9a227' : s.notional > 500 ? '#4f8bf9' : '#34d399')
        },
        text: sectorsSorted.map(s => `$${s.notional}M (${s.pct}%)`),
        textposition: 'outside',
        textfont: { size: 9, color: '#9ca3b4' },
        customdata: sectorsSorted.map(s => s.names),
        hovertemplate: '<b>%{y}</b><br>$%{x}M<br>Key: %{customdata}<extra></extra>'
    }], plotlyDarkLayout({
        margin: { l: 160, r: 80, t: 10, b: 40 },
        xaxis: { title: 'Notional ($M)', gridcolor: 'rgba(156,163,180,0.08)' },
        yaxis: { tickfont: { size: 10 } }
    }), plotlyConfig());

    // Sector Composition Shift (grouped horizontal bar with shift arrows)
    const shiftData = sectorShift; // already sorted by shift ascending
    Plotly.newPlot('asiaSectorShiftChart', [
        {
            y: shiftData.map(s => s.sector),
            x: shiftData.map(s => s.prePct),
            type: 'bar',
            orientation: 'h',
            name: 'Pre-Holiday',
            marker: { color: 'rgba(79, 139, 249, 0.7)' },
            text: shiftData.map(s => s.prePct.toFixed(1) + '%'),
            textposition: 'inside',
            textfont: { size: 9, color: '#e8e9eb' },
            hovertemplate: '<b>%{y}</b><br>Pre: %{x:.1f}%<br>$%{customdata}M<extra>Pre-Holiday</extra>',
            customdata: shiftData.map(s => s.preM)
        },
        {
            y: shiftData.map(s => s.sector),
            x: shiftData.map(s => s.durPct),
            type: 'bar',
            orientation: 'h',
            name: 'During Holiday',
            marker: { color: 'rgba(201, 162, 39, 0.7)' },
            text: shiftData.map(s => s.durPct.toFixed(1) + '%'),
            textposition: 'inside',
            textfont: { size: 9, color: '#e8e9eb' },
            hovertemplate: '<b>%{y}</b><br>During: %{x:.1f}%<br>$%{customdata}M<extra>During Holiday</extra>',
            customdata: shiftData.map(s => s.durM)
        }
    ], plotlyDarkLayout({
        margin: { l: 140, r: 50, t: 30, b: 50 },
        barmode: 'group',
        xaxis: { title: 'Share of Overnight Notional (%)', gridcolor: 'rgba(156,163,180,0.08)' },
        yaxis: { tickfont: { size: 9 }, autorange: 'reversed' },
        legend: { x: 0.6, y: 1.1, orientation: 'h', font: { size: 10 } },
        annotations: shiftData.filter(s => Math.abs(s.shift) >= 1.0).map(s => ({
            x: Math.max(s.prePct, s.durPct) + 1.5,
            y: s.sector,
            text: (s.shift > 0 ? '+' : '') + s.shift.toFixed(1) + 'pp',
            showarrow: false,
            font: { size: 9, color: s.shift > 0 ? '#34d399' : '#f87171', family: 'JetBrains Mono' }
        }))
    }), plotlyConfig());

    // Asia-Linked Ticker Impact (bar chart: % change)
    const tickerData = asiaLinkedTickers.filter(t => t.preM >= 0.5);
    Plotly.newPlot('asiaTickerChart', [{
        x: tickerData.map(t => t.symbol),
        y: tickerData.map(t => t.changePct),
        type: 'bar',
        marker: {
            color: tickerData.map(t =>
                t.changePct > 50 ? '#34d399' :
                t.changePct > 0 ? 'rgba(52, 211, 153, 0.5)' :
                t.changePct > -50 ? 'rgba(248, 113, 113, 0.5)' :
                '#f87171'
            )
        },
        text: tickerData.map(t => (t.changePct > 0 ? '+' : '') + t.changePct + '%'),
        textposition: 'outside',
        textfont: { size: 9, color: '#9ca3b4' },
        hovertemplate: '<b>%{x}</b> (%{customdata})<br>Change: %{y}%<extra></extra>',
        customdata: tickerData.map(t => t.region)
    }], plotlyDarkLayout({
        margin: { l: 50, r: 20, t: 20, b: 60 },
        yaxis: { title: 'Notional Change (%)', gridcolor: 'rgba(156,163,180,0.08)', zeroline: true, zerolinecolor: 'rgba(156,163,180,0.3)' },
        xaxis: { tickangle: -35, tickfont: { size: 10 } },
        shapes: [{
            type: 'line', x0: -0.5, x1: tickerData.length - 0.5, y0: 0, y1: 0,
            line: { color: 'rgba(156,163,180,0.3)', width: 1.5, dash: 'dot' }
        }]
    }), plotlyConfig());
}

// ============================================================================
// TAB 12: METHODOLOGY
// ============================================================================

function renderMethodologyTab() {
    const container = document.getElementById('tab-methodology');
    
    container.innerHTML = `
        <div class="methodology-content">
            <h3>Research Framework</h3>
            <p>
                This analysis follows the overnight equity return decomposition framework established by 
                Lou, Polk & Skouras (2019) in "A Tug of War: Overnight Versus Intraday Expected Returns" 
                published in the <em>Journal of Financial Economics</em>.
            </p>
            
            <h3>Key Metrics</h3>
            
            <p><strong>Reference Gap (bps)</strong></p>
            <p>
                The price movement from prior market close to overnight VWAP, representing the 
                portion of the overnight gap captured at execution:
            </p>
            <div class="formula-box">
                Reference Gap = ((VWAP - Prior Close) / Prior Close) × 10,000
            </div>
            
            <p><strong>Timing Differential (bps)</strong></p>
            <p>
                The raw price movement from overnight VWAP to next-day market open. This is a
                directionally signed metric used for quadrant classification:
            </p>
            <div class="formula-box">
                Timing Differential = ((Next Open - VWAP) / Prior Close) × 10,000
            </div>

            <p><strong>Captured Alpha (bps)</strong></p>
            <p>
                The sign-corrected momentum capture. Measures how much of the directional overnight
                gap the execution captured. Positive values indicate the momentum trade was profitable
                (long in an up gap, or short in a down gap):
            </p>
            <div class="formula-box">
                Captured Alpha = Timing Differential × Gap Sign (+1 for UP, -1 for DOWN)
            </div>

            <p><strong>Total Overnight Gap (bps)</strong></p>
            <p>
                The complete overnight price movement from prior close to next-day open:
            </p>
            <div class="formula-box">
                Total Gap = ((Next Open - Prior Close) / Prior Close) × 10,000
            </div>
            
            <p><strong>Price Continuity Rate</strong></p>
            <p>
                The percentage of observations where the overnight execution price (VWAP) falls 
                between the prior close and next-day open in the direction of the overnight gap. 
                This measures execution quality relative to the overnight drift.
            </p>
            
            <h3>Quadrant Classification</h3>
            <ul>
                <li><strong>Q1 (Momentum):</strong> Positive Reference Gap, Positive Timing Differential</li>
                <li><strong>Q2 (Mean Reversion):</strong> Negative Reference Gap, Positive Timing Differential</li>
                <li><strong>Q3 (Protection):</strong> Negative Reference Gap, Negative Timing Differential</li>
                <li><strong>Q4 (Top Tick):</strong> Positive Reference Gap, Negative Timing Differential</li>
            </ul>

            <h3>Overnight Price Drift</h3>
            <p>The lambda coefficient measures how far the overnight VWAP (P<sub>v</sub>) sits along the drift from prior close (P<sub>t</sub>) to next-day open (P<sub>a</sub>).</p>
            <div class="methodology-diagram">
                <svg viewBox="0 0 800 350" xmlns="http://www.w3.org/2000/svg" class="diagram-svg">
                    <!-- Background grid -->
                    <defs>
                        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(156,163,180,0.06)" stroke-width="0.5"/>
                        </pattern>
                    </defs>
                    <rect width="800" height="350" fill="var(--card-bg, #141418)" rx="8"/>
                    <rect width="800" height="350" fill="url(#grid)" rx="8"/>

                    <!-- Phase labels -->
                    <text x="150" y="30" fill="#9ca3b4" font-size="13" font-family="Inter" text-anchor="middle" font-weight="600">Day 0</text>
                    <text x="400" y="30" fill="#9ca3b4" font-size="13" font-family="Inter" text-anchor="middle" font-weight="600">Overnight</text>
                    <text x="650" y="30" fill="#9ca3b4" font-size="13" font-family="Inter" text-anchor="middle" font-weight="600">Day 1</text>

                    <!-- Vertical dividers -->
                    <line x1="265" y1="40" x2="265" y2="280" stroke="rgba(156,163,180,0.15)" stroke-width="1" stroke-dasharray="4,4"/>
                    <line x1="535" y1="40" x2="535" y2="280" stroke="rgba(156,163,180,0.15)" stroke-width="1" stroke-dasharray="4,4"/>

                    <!-- Day 0 price line (uptrending intraday) -->
                    <polyline points="40,230 70,225 90,220 110,228 130,215 150,210 170,218 190,205 210,200 230,195 250,190 265,185"
                              fill="none" stroke="#e8e9eb" stroke-width="1.5" stroke-linejoin="round"/>

                    <!-- Overnight dashed drift line -->
                    <line x1="265" y1="185" x2="535" y2="130" stroke="rgba(156,163,180,0.35)" stroke-width="2" stroke-dasharray="8,6"/>

                    <!-- Day 1 price line (continuing uptrend) -->
                    <polyline points="535,130 555,128 570,135 590,125 610,120 630,128 650,118 670,115 690,122 710,110 730,108 750,115 770,105"
                              fill="none" stroke="#e8e9eb" stroke-width="1.5" stroke-linejoin="round"/>

                    <!-- Pt dot (Prior Close) -->
                    <circle cx="265" cy="185" r="7" fill="#9ca3b4" stroke="#e8e9eb" stroke-width="2"/>
                    <text x="250" y="210" fill="#9ca3b4" font-size="14" font-family="Source Serif 4" font-style="italic">P</text>
                    <text x="263" y="214" fill="#9ca3b4" font-size="10" font-family="Source Serif 4" font-style="italic">t</text>

                    <!-- Pv dot (VWAP) -->
                    <circle cx="400" cy="158" r="7" fill="#c9a227" stroke="#fbbf24" stroke-width="2"/>
                    <text x="410" y="152" fill="#c9a227" font-size="14" font-family="Source Serif 4" font-style="italic">P</text>
                    <text x="423" y="156" fill="#c9a227" font-size="10" font-family="Source Serif 4" font-style="italic">v</text>

                    <!-- Pa dot (Next Open) -->
                    <circle cx="535" cy="130" r="7" fill="#e8e9eb" stroke="#e8e9eb" stroke-width="2"/>
                    <text x="545" y="125" fill="#e8e9eb" font-size="14" font-family="Source Serif 4" font-style="italic">P</text>
                    <text x="558" y="129" fill="#e8e9eb" font-size="10" font-family="Source Serif 4" font-style="italic">a</text>

                    <!-- Y axis label -->
                    <text x="25" y="170" fill="#9ca3b4" font-size="12" font-family="Inter">Y</text>

                    <!-- X axis -->
                    <line x1="40" y1="280" x2="770" y2="280" stroke="rgba(156,163,180,0.2)" stroke-width="1"/>
                    <text x="265" y="298" fill="rgba(156,163,180,0.5)" font-size="11" font-family="Inter" text-anchor="middle">X</text>
                    <text x="400" y="298" fill="rgba(156,163,180,0.5)" font-size="10" font-family="Inter" text-anchor="middle">Overnight interval</text>

                    <!-- Lambda formula -->
                    <rect x="560" y="200" width="220" height="90" rx="6" fill="rgba(10,10,10,0.6)" stroke="rgba(156,163,180,0.1)" stroke-width="1"/>
                    <text x="670" y="228" fill="#e8e9eb" font-size="18" font-family="Source Serif 4" text-anchor="middle" font-style="italic">
                        <tspan font-size="22">\u03BB</tspan> =
                    </text>
                    <line x1="620" y1="248" x2="720" y2="248" stroke="#e8e9eb" stroke-width="1.5"/>
                    <text x="670" y="244" fill="#e8e9eb" font-size="13" font-family="Source Serif 4" text-anchor="middle" font-style="italic">
                        <tspan fill="#c9a227">P<tspan font-size="9" dy="3">v</tspan><tspan dy="-3"> </tspan></tspan> \u2212 P<tspan font-size="9" dy="3">a</tspan>
                    </text>
                    <text x="670" y="268" fill="#e8e9eb" font-size="13" font-family="Source Serif 4" text-anchor="middle" font-style="italic">
                        P<tspan font-size="9" dy="3">t</tspan><tspan dy="-3"> </tspan> \u2212 P<tspan font-size="9" dy="3">a</tspan>
                    </text>
                </svg>
            </div>

            <h3>Understanding Price Continuity</h3>
            <p>Price continuity measures whether the overnight execution (VWAP) falls between the prior close and next-day open, indicating orderly price discovery during the overnight session.</p>
            <div class="methodology-diagram continuity-diagram">
                <div class="continuity-grid">
                    <!-- Scenario 1: Continuous Downward -->
                    <div class="continuity-card">
                        <div class="continuity-label">CONTINUOUS <span class="label-sub">(Downward Drift)</span></div>
                        <svg viewBox="0 0 280 160" xmlns="http://www.w3.org/2000/svg" class="diagram-svg-small">
                            <rect width="280" height="160" fill="transparent"/>
                            <!-- Price levels -->
                            <text x="20" y="45" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$152</text>
                            <text x="20" y="82" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$149</text>
                            <text x="20" y="118" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$146</text>
                            <!-- Grid lines -->
                            <line x1="60" y1="40" x2="260" y2="40" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <line x1="60" y1="77" x2="260" y2="77" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <line x1="60" y1="113" x2="260" y2="113" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <!-- Connecting line -->
                            <line x1="90" y1="42" x2="240" y2="115" stroke="rgba(156,163,180,0.25)" stroke-width="1.5"/>
                            <!-- PC dot -->
                            <circle cx="90" cy="42" r="8" fill="#1a1f2e" stroke="#e8e9eb" stroke-width="2"/>
                            <text x="90" y="30" fill="#e8e9eb" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">PC</text>
                            <!-- BO dot -->
                            <circle cx="160" cy="78" r="8" fill="#4f8bf9" stroke="#6da0fa" stroke-width="2"/>
                            <text x="160" y="66" fill="#4f8bf9" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">BO</text>
                            <!-- O dot -->
                            <circle cx="240" cy="115" r="8" fill="#6b7280" stroke="#9ca3b4" stroke-width="2"/>
                            <text x="240" y="103" fill="#9ca3b4" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">O</text>
                            <!-- Labels -->
                            <text x="75" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">Prior Close</text>
                            <text x="140" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">ATS</text>
                            <text x="215" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">Next Open</text>
                        </svg>
                        <div class="continuity-formula">PC &gt; BO &gt; O <span class="check-mark">\u2713</span></div>
                    </div>

                    <!-- Scenario 2: Continuous Upward -->
                    <div class="continuity-card">
                        <div class="continuity-label">CONTINUOUS <span class="label-sub">(Upward Drift)</span></div>
                        <svg viewBox="0 0 280 160" xmlns="http://www.w3.org/2000/svg" class="diagram-svg-small">
                            <rect width="280" height="160" fill="transparent"/>
                            <text x="20" y="45" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$148</text>
                            <text x="20" y="82" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$145</text>
                            <text x="20" y="118" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$142</text>
                            <line x1="60" y1="40" x2="260" y2="40" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <line x1="60" y1="77" x2="260" y2="77" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <line x1="60" y1="113" x2="260" y2="113" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <!-- Connecting line -->
                            <line x1="90" y1="115" x2="240" y2="42" stroke="rgba(156,163,180,0.25)" stroke-width="1.5"/>
                            <!-- PC dot (low) -->
                            <circle cx="90" cy="115" r="8" fill="#1a1f2e" stroke="#e8e9eb" stroke-width="2"/>
                            <text x="90" y="103" fill="#e8e9eb" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">PC</text>
                            <!-- BO dot (middle) -->
                            <circle cx="160" cy="78" r="8" fill="#4f8bf9" stroke="#6da0fa" stroke-width="2"/>
                            <text x="160" y="66" fill="#4f8bf9" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">BO</text>
                            <!-- O dot (high) -->
                            <circle cx="240" cy="42" r="8" fill="#6b7280" stroke="#9ca3b4" stroke-width="2"/>
                            <text x="240" y="30" fill="#9ca3b4" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">O</text>
                            <text x="75" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">Prior Close</text>
                            <text x="140" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">ATS</text>
                            <text x="215" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">Next Open</text>
                        </svg>
                        <div class="continuity-formula">PC &lt; BO &lt; O <span class="check-mark">\u2713</span></div>
                    </div>

                    <!-- Scenario 3: Non-Continuous -->
                    <div class="continuity-card non-continuous">
                        <div class="continuity-label">NON-CONTINUOUS <span class="label-sub">(Price Outside Sequential Path)</span></div>
                        <svg viewBox="0 0 280 160" xmlns="http://www.w3.org/2000/svg" class="diagram-svg-small">
                            <rect width="280" height="160" fill="transparent"/>
                            <text x="20" y="45" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$154</text>
                            <text x="20" y="75" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$152</text>
                            <text x="20" y="118" fill="#9ca3b4" font-size="10" font-family="JetBrains Mono">$146</text>
                            <line x1="60" y1="40" x2="260" y2="40" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <line x1="60" y1="70" x2="260" y2="70" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <line x1="60" y1="113" x2="260" y2="113" stroke="rgba(156,163,180,0.08)" stroke-width="0.5"/>
                            <!-- Dashed lines showing expected path -->
                            <line x1="90" y1="70" x2="160" y2="40" stroke="rgba(79,139,249,0.3)" stroke-width="1.5" stroke-dasharray="4,4"/>
                            <line x1="160" y1="40" x2="240" y2="115" stroke="rgba(79,139,249,0.3)" stroke-width="1.5" stroke-dasharray="4,4"/>
                            <!-- PC dot -->
                            <circle cx="90" cy="70" r="8" fill="#1a1f2e" stroke="#e8e9eb" stroke-width="2"/>
                            <text x="90" y="58" fill="#e8e9eb" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">PC</text>
                            <!-- BO dot (above PC, breaking continuity) -->
                            <circle cx="160" cy="40" r="8" fill="#4f8bf9" stroke="#6da0fa" stroke-width="2"/>
                            <text x="160" y="28" fill="#4f8bf9" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">BO</text>
                            <!-- O dot (below PC) -->
                            <circle cx="240" cy="115" r="8" fill="#6b7280" stroke="#9ca3b4" stroke-width="2"/>
                            <text x="240" y="103" fill="#9ca3b4" font-size="9" font-family="Inter" text-anchor="middle" font-weight="600">O</text>
                            <!-- Annotation arrow -->
                            <text x="200" y="50" fill="#f87171" font-size="8" font-family="Inter" text-anchor="end">ATS price above</text>
                            <text x="200" y="60" fill="#f87171" font-size="8" font-family="Inter" text-anchor="end">prior close</text>
                            <line x1="203" y1="47" x2="152" y2="42" stroke="#f87171" stroke-width="0.8" marker-end="none"/>
                            <text x="75" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">Prior Close</text>
                            <text x="140" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">ATS</text>
                            <text x="215" y="148" fill="#9ca3b4" font-size="9" font-family="Inter">Next Open</text>
                        </svg>
                        <div class="continuity-formula fail">PC &gt; BO &gt; O <span class="x-mark">\u2717</span> (BO not between PC and O)</div>
                    </div>
                </div>
            </div>

            <h3>Data Processing</h3>
            <p>
                Observations are filtered to institutional-scale positions (≥$50K notional). 
                ETF classifications are derived from category patterns. Sectors for stocks 
                are sourced from market data providers; ETFs display their category classification 
                instead.
            </p>
            
            <p><strong>Winsorization</strong></p>
            <p>
                To prevent extreme outliers from distorting visualizations, metrics are winsorized 
                at the 1st and 99th percentiles for chart display. The current bounds are:
            </p>
            <ul>
                <li>Captured Alpha: ${META.winsor.ca ? formatBps(META.winsor.ca[0]) : '-'} to ${META.winsor.ca ? formatBps(META.winsor.ca[1]) : '-'}</li>
                <li>Timing Differential: ${formatBps(META.winsor.td[0])} to ${formatBps(META.winsor.td[1])}</li>
                <li>Reference Gap: ${formatBps(META.winsor.rg[0])} to ${formatBps(META.winsor.rg[1])}</li>
            </ul>
            <p>
                True (non-winsorized) values are always displayed in tables and position details. 
                Use the "Full Range" toggle to view charts with complete data distribution.
            </p>
            
            <h3>Data Sources</h3>
            <ul>
                <li>Overnight trading data: BlueOcean ATS Market Data Statistics</li>
                <li>Market reference prices: Public market data via financial APIs</li>
                <li>Symbol classifications: Pattern detection and market data enrichment</li>
            </ul>
        </div>
        
        <div class="disclaimer">
            <div class="disclaimer-title">Disclaimer</div>
            <p>
                This analysis constitutes independent research on market microstructure
                and is not intended as investment advice. Past performance does not guarantee
                future results. All statistics are observational and based on historical data
                from ${META.dateRange[0]} to ${META.dateRange[1]}. Sapinover LLC is retained by BlueOcean ATS
                on a flat monthly fee for research services and does not receive
                transaction-based compensation. No investment recommendations are made herein.
            </p>
        </div>
    `;
}

// ============================================================================
// MODAL FUNCTIONALITY
// ============================================================================

function showPositionModal(symbol, date) {
    const d = FILTERED_DATA.find(row => row.symbol === symbol && row.date === date);
    if (!d) return;
    
    const q = getQuadrant(d);
    const qInfo = getQuadrantInfo(q);
    
    const vsOpen = d.vwap && d.nextOpen ? ((d.nextOpen - d.vwap) / d.vwap) * 10000 : null;
    const vsClose = d.vwap && d.nextClose ? ((d.nextClose - d.vwap) / d.vwap) * 10000 : null;
    
    document.getElementById('modalSymbol').textContent = d.symbol;
    document.getElementById('modalCompany').textContent = d.company;
    
    document.getElementById('modalBody').innerHTML = `
        <div class="modal-grid">
            <div class="modal-stat">
                <strong>Notional</strong>
                <div class="val">${formatCurrency(d.notional, true)}</div>
            </div>
            <div class="modal-stat">
                <strong>Volume</strong>
                <div class="val">${formatNumber(d.volume)}</div>
            </div>
            <div class="modal-stat">
                <strong>Executions</strong>
                <div class="val">${formatNumber(d.executions)}</div>
            </div>
            <div class="modal-stat">
                <strong>Captured Alpha</strong>
                <div class="val ${getValueClass(d.capturedAlpha)}">${formatBps(d.capturedAlpha, true)}</div>
            </div>
            <div class="modal-stat">
                <strong>Reference Gap</strong>
                <div class="val ${getValueClass(d.refGap)}">${formatBps(d.refGap, true)}</div>
            </div>
            <div class="modal-stat">
                <strong>Quadrant</strong>
                <div class="val" style="color: ${qInfo.color};">${q}: ${qInfo.name}</div>
            </div>
        </div>
        
        <div class="modal-section">
            <h4>Pricing Data</h4>
            <div class="modal-section-grid">
                <span><strong>Prior Close:</strong> ${d.priorClose ? '$' + d.priorClose.toFixed(2) : '-'}</span>
                <span><strong>VWAP:</strong> ${d.vwap ? '$' + d.vwap.toFixed(4) : '-'}</span>
                <span><strong>Next Open:</strong> ${d.nextOpen ? '$' + d.nextOpen.toFixed(2) : '-'}</span>
                <span><strong>Next Close:</strong> ${d.nextClose ? '$' + d.nextClose.toFixed(2) : '-'}</span>
            </div>
        </div>
        
        <div class="modal-section">
            <h4>Performance Metrics</h4>
            <div class="modal-section-grid">
                <span><strong>Total Overnight Gap:</strong> <span class="${getValueClass(d.totalGap)}">${formatBps(d.totalGap, true)}</span></span>
                <span><strong>Gap Direction:</strong> ${d.gapDirection}</span>
                <span><strong>VS Next Open:</strong> <span class="${getValueClass(vsOpen)}">${vsOpen !== null ? formatBps(vsOpen, true) : '-'}</span></span>
                <span><strong>VS Next Close:</strong> <span class="${getValueClass(vsClose)}">${vsClose !== null ? formatBps(vsClose, true) : '-'}</span></span>
                <span><strong>Price Continuity:</strong> ${d.dirConsistency ? '<span class="positive">✓ Yes</span>' : '<span class="negative">✗ No</span>'}</span>
                <span><strong>Timing Differential:</strong> <span class="${getValueClass(d.timingDiff)}">${formatBps(d.timingDiff, true)}</span></span>
                <span><strong>Outlier Flag:</strong> ${d.isOutlier ? '<span class="negative">Yes</span>' : 'No'}</span>
            </div>
        </div>
        
        <div class="modal-section">
            <h4>Position Details</h4>
            <div class="modal-section-grid">
                <span><strong>Asset Type:</strong> ${d.assetType}</span>
                <span><strong>Sector:</strong> ${d.sector}</span>
                <span><strong>Trade Date:</strong> ${d.date}</span>
                <span><strong>Leverage:</strong> ${d.leverageMult}</span>
                ${d.marketCap ? `<span><strong>Market Cap:</strong> $${d.marketCap.toFixed(1)}B</span>` : ''}
            </div>
        </div>
    `;
    
    document.getElementById('positionModal').classList.add('active');
}

function closeModal() {
    document.getElementById('positionModal').classList.remove('active');
}

// Close modal on outside click
document.getElementById('positionModal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
});

// Close modal on escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeModal();
});
