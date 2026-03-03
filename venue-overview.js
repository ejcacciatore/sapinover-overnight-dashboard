// Sapinover LLC - Overnight Session Overview v1.0
// Rendering logic for three-venue ATS session dashboard

// ============================================================================
// GLOBAL STATE
// ============================================================================

let DATA = null;
let LOOKUP = null;
let META = null;
let CURRENT_DATE = null;

// Chart instances (for cleanup on date change)
let chartInstances = {};
let plotlyCharts = [];

// Venue config
const VENUES = {
    boats: { label: 'BlueOcean', color: '#f5a623', colorDim: 'rgba(245,166,35,0.15)', dotClass: 'dot-boats' },
    bruce: { label: 'Bruce', color: '#42a5f5', colorDim: 'rgba(66,165,245,0.15)', dotClass: 'dot-bruce' },
    moon:  { label: 'Moon', color: '#ab47bc', colorDim: 'rgba(171,71,188,0.15)', dotClass: 'dot-moon' }
};
const VENUE_KEYS = ['boats', 'bruce', 'moon'];

// Plotly layout defaults (dark theme)
const PLOTLY_LAYOUT = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Outfit, sans-serif', color: '#8a8a96', size: 11 },
    margin: { t: 10, r: 20, b: 40, l: 50 },
    xaxis: { gridcolor: 'rgba(255,255,255,0.04)', zerolinecolor: 'rgba(255,255,255,0.08)' },
    yaxis: { gridcolor: 'rgba(255,255,255,0.04)', zerolinecolor: 'rgba(255,255,255,0.08)' },
    legend: { orientation: 'h', y: -0.15, font: { size: 11 } },
    bargap: 0.15
};

const PLOTLY_CONFIG = {
    displayModeBar: false,
    responsive: true
};

// ============================================================================
// INITIALIZATION
// ============================================================================

window.initVenueOverview = function(json) {
    DATA = json.dates || {};
    LOOKUP = json.lookup || {};
    META = json.meta || {};

    // Populate date selector
    const selector = document.getElementById('dateSelector');
    const dates = Object.keys(DATA).sort().reverse();
    selector.innerHTML = '';
    dates.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = formatDateDisplay(d);
        selector.appendChild(opt);
    });

    // Default to latest
    CURRENT_DATE = META.latestDate || dates[0];
    selector.value = CURRENT_DATE;

    renderDate(CURRENT_DATE);
};

window.renderDate = function(dateStr) {
    CURRENT_DATE = dateStr;
    const dd = DATA[dateStr];
    if (!dd) return;

    // Destroy existing Chart.js instances
    Object.values(chartInstances).forEach(c => { try { c.destroy(); } catch(e) {} });
    chartInstances = {};

    // Clear Plotly charts
    plotlyCharts.forEach(id => { try { Plotly.purge(id); } catch(e) {} });
    plotlyCharts = [];

    renderKPIs(dd);
    renderVenueVolume(dd);
    renderTopTickers(dd);
    renderSectors(dd);
    renderDirection(dd);
    renderSpreadLiquidity(dd);
    renderOverlap(dd);
    renderHistorical();
    renderDisclaimer();
};

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

function formatDateDisplay(dateStr) {
    const [y, m, d] = dateStr.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
}

function fmtDollar(v) {
    if (v == null || isNaN(v)) return '-';
    if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v.toFixed(0);
}

function fmtNum(v) {
    if (v == null || isNaN(v)) return '-';
    return v.toLocaleString('en-US');
}

function fmtBps(v) {
    if (v == null || isNaN(v)) return '-';
    const sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(1) + ' bps';
}

function fmtPct(v) {
    if (v == null || isNaN(v)) return '-';
    return v.toFixed(1) + '%';
}

function fmtPrice(v) {
    if (v == null || isNaN(v)) return '-';
    return '$' + v.toFixed(2);
}

function bpsClass(v) {
    if (v == null || isNaN(v)) return '';
    return v >= 0 ? 'val-pos' : 'val-neg';
}

function sym(idx) {
    return (LOOKUP.symbols && LOOKUP.symbols[idx]) || `#${idx}`;
}

function sectorName(idx) {
    return (LOOKUP.sectors && LOOKUP.sectors[idx]) || 'Unknown';
}

function companyName(idx) {
    return (LOOKUP.companies && LOOKUP.companies[idx]) || '';
}

// ============================================================================
// SECTION: KPI HERO CARDS
// ============================================================================

function renderKPIs(dd) {
    const s = dd.summary;
    let totalNotional = 0, totalVolume = 0, totalTrades = 0;
    const allSymbols = new Set();
    let activeVenues = 0;
    let weightedBps = 0, totalWeight = 0;

    VENUE_KEYS.forEach(v => {
        if (s[v]) {
            totalNotional += s[v].notional || 0;
            totalVolume += s[v].volume || 0;
            totalTrades += s[v].trades || 0;
            if (s[v].notional > 0) activeVenues++;
            // Weighted net indication
            if (s[v].netIndicationBps != null && s[v].symbolsWithIndication > 0) {
                weightedBps += s[v].netIndicationBps * s[v].symbolsWithIndication;
                totalWeight += s[v].symbolsWithIndication;
            }
        }
    });

    // Count unique symbols from overlap
    const uniqueSymbols = dd.overlap && dd.overlap.counts ? dd.overlap.counts.total : 0;
    const netIndication = totalWeight > 0 ? weightedBps / totalWeight : null;

    const kpis = [
        { value: fmtDollar(totalNotional), label: 'Total Notional', cls: '' },
        { value: fmtNum(totalVolume), label: 'Total Share Volume', cls: '' },
        { value: fmtNum(totalTrades), label: 'Total Trades', cls: '' },
        { value: fmtNum(uniqueSymbols), label: 'Unique Symbols', cls: '' },
        { value: activeVenues + ' / 3', label: 'Active Venues', cls: '' },
        {
            value: netIndication != null ? fmtBps(netIndication) : '-',
            label: 'Net Overnight Indication',
            cls: netIndication != null ? (netIndication >= 0 ? 'up' : 'down') : ''
        }
    ];

    const grid = document.getElementById('kpiGrid');
    grid.innerHTML = kpis.map(k =>
        `<div class="kpi-card">
            <div class="kpi-value ${k.cls}">${k.value}</div>
            <div class="kpi-label">${k.label}</div>
        </div>`
    ).join('');
}

// ============================================================================
// SECTION 1: VENUE VOLUME COMPARISON
// ============================================================================

function renderVenueVolume(dd) {
    const s = dd.summary;

    // Bar chart: Notional by venue
    const ctx = document.getElementById('chartNotional');
    if (chartInstances.notional) { try { chartInstances.notional.destroy(); } catch(e) {} }

    const labels = VENUE_KEYS.filter(v => s[v] && s[v].notional > 0).map(v => VENUES[v].label);
    const values = VENUE_KEYS.filter(v => s[v] && s[v].notional > 0).map(v => s[v].notional);
    const colors = VENUE_KEYS.filter(v => s[v] && s[v].notional > 0).map(v => VENUES[v].color);

    chartInstances.notional = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: colors,
                borderRadius: 4,
                maxBarThickness: 60
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => fmtDollar(ctx.raw)
                    }
                }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                        color: '#8a8a96',
                        font: { family: 'Outfit', size: 11 },
                        callback: v => fmtDollar(v)
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#8a8a96', font: { family: 'Outfit', size: 11 } }
                }
            }
        }
    });

    // Summary table
    const table = document.getElementById('venueSummaryTable');
    let html = `<thead><tr>
        <th>Venue</th><th>Notional</th><th>Volume</th>
        <th>Trades</th><th>Symbols</th><th>% of Total</th>
    </tr></thead><tbody>`;

    const totalNotional = VENUE_KEYS.reduce((sum, v) => sum + (s[v] ? s[v].notional || 0 : 0), 0);

    VENUE_KEYS.forEach(v => {
        if (!s[v] || s[v].notional === 0) return;
        const pct = totalNotional > 0 ? (s[v].notional / totalNotional * 100) : 0;
        html += `<tr>
            <td><span class="venue-dot ${VENUES[v].dotClass}"></span>${VENUES[v].label}</td>
            <td class="mono">${fmtDollar(s[v].notional)}</td>
            <td class="mono">${fmtNum(s[v].volume)}</td>
            <td class="mono">${fmtNum(s[v].trades)}</td>
            <td class="mono">${fmtNum(s[v].symbols)}</td>
            <td class="mono">${fmtPct(pct)}</td>
        </tr>`;
    });
    html += '</tbody>';
    table.innerHTML = html;
}

// ============================================================================
// SECTION 2: TOP TICKERS BY NOTIONAL
// ============================================================================

function renderTopTickers(dd) {
    const grid = document.getElementById('topTickersGrid');
    grid.innerHTML = '';

    VENUE_KEYS.forEach(v => {
        const tickers = dd.topTickers && dd.topTickers[v] ? dd.topTickers[v] : [];
        const card = document.createElement('div');
        card.className = 'card';

        let html = `<h3><span class="venue-dot ${VENUES[v].dotClass}"></span>${VENUES[v].label} Top 15</h3>`;
        html += `<table class="venue-table"><thead><tr>
            <th>#</th><th>Symbol</th><th>Notional</th><th>VWAP</th><th>Indication</th>
        </tr></thead><tbody>`;

        tickers.forEach((row, i) => {
            // [symIdx, notional, volume, trades, vwap, indicationBps]
            const [symIdx, notional, volume, trades, vwap, indBps] = row;
            html += `<tr>
                <td class="mono" style="color:var(--text-muted)">${i + 1}</td>
                <td style="font-weight:500">${sym(symIdx)}</td>
                <td class="mono">${fmtDollar(notional)}</td>
                <td class="mono">${fmtPrice(vwap)}</td>
                <td class="mono ${bpsClass(indBps)}">${fmtBps(indBps)}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        card.innerHTML = html;
        grid.appendChild(card);
    });
}

// ============================================================================
// SECTION 3: SECTOR DISTRIBUTION
// ============================================================================

function renderSectors(dd) {
    const el = document.getElementById('chartSectors');

    // Build traces: horizontal stacked bars, one trace per venue
    const traces = [];
    const allSectorIdxs = new Set();

    VENUE_KEYS.forEach(v => {
        const sectors = dd.sectors && dd.sectors[v] ? dd.sectors[v] : [];
        sectors.forEach(row => allSectorIdxs.add(row[0]));
    });

    // Sort sectors by total notional descending
    const sectorTotals = {};
    allSectorIdxs.forEach(idx => {
        sectorTotals[idx] = 0;
        VENUE_KEYS.forEach(v => {
            const sectors = dd.sectors && dd.sectors[v] ? dd.sectors[v] : [];
            const match = sectors.find(r => r[0] === idx);
            if (match) sectorTotals[idx] += match[1];
        });
    });

    const sortedSectors = [...allSectorIdxs].sort((a, b) => sectorTotals[b] - sectorTotals[a]);
    const sectorLabels = sortedSectors.map(idx => sectorName(idx));

    VENUE_KEYS.forEach(v => {
        const sectors = dd.sectors && dd.sectors[v] ? dd.sectors[v] : [];
        const sectorMap = {};
        sectors.forEach(row => { sectorMap[row[0]] = row[1]; });

        traces.push({
            y: sectorLabels,
            x: sortedSectors.map(idx => (sectorMap[idx] || 0) / 1e6),
            name: VENUES[v].label,
            type: 'bar',
            orientation: 'h',
            marker: { color: VENUES[v].color },
            hovertemplate: VENUES[v].label + ': $%{x:.1f}M<extra></extra>'
        });
    });

    const layout = {
        ...PLOTLY_LAYOUT,
        barmode: 'stack',
        margin: { t: 10, r: 20, b: 40, l: 120 },
        xaxis: {
            ...PLOTLY_LAYOUT.xaxis,
            title: { text: 'Notional ($M)', font: { size: 11, color: '#8a8a96' } }
        },
        yaxis: {
            ...PLOTLY_LAYOUT.yaxis,
            autorange: 'reversed'
        },
        height: Math.max(300, sortedSectors.length * 32 + 60),
        legend: { ...PLOTLY_LAYOUT.legend }
    };

    Plotly.newPlot(el, traces, layout, PLOTLY_CONFIG);
    plotlyCharts.push('chartSectors');
}

// ============================================================================
// SECTION 4: OVERNIGHT DIRECTION
// ============================================================================

function renderDirection(dd) {
    // Histogram
    const el = document.getElementById('chartDirection');
    const traces = [];

    VENUE_KEYS.forEach(v => {
        const dir = dd.direction && dd.direction[v] ? dd.direction[v] : null;
        if (!dir) return;

        // bins are edges, counts are per-bin values
        // Create bar centers from bin edges
        const bins = dir.bins;
        const counts = dir.counts;
        const centers = [];
        for (let i = 0; i < counts.length; i++) {
            centers.push((bins[i] + bins[i + 1]) / 2);
        }

        // Build labels for the bin ranges
        const labels = [];
        for (let i = 0; i < counts.length; i++) {
            labels.push(`${bins[i]} to ${bins[i+1]} bps`);
        }

        traces.push({
            x: centers,
            y: counts,
            name: VENUES[v].label,
            type: 'bar',
            marker: {
                color: VENUES[v].color,
                opacity: 0.7
            },
            hovertemplate: VENUES[v].label + '<br>%{customdata}<br>Count: %{y}<extra></extra>',
            customdata: labels
        });
    });

    const layout = {
        ...PLOTLY_LAYOUT,
        barmode: 'group',
        xaxis: {
            ...PLOTLY_LAYOUT.xaxis,
            title: { text: 'VWAP vs Prior Close (bps)', font: { size: 11, color: '#8a8a96' } },
            dtick: 100
        },
        yaxis: {
            ...PLOTLY_LAYOUT.yaxis,
            title: { text: 'Symbol Count', font: { size: 11, color: '#8a8a96' } }
        },
        legend: { ...PLOTLY_LAYOUT.legend },
        height: 300
    };

    Plotly.newPlot(el, traces, layout, PLOTLY_CONFIG);
    plotlyCharts.push('chartDirection');

    // Direction summary table
    const table = document.getElementById('directionTable');
    let html = `<thead><tr>
        <th>Venue</th><th>Symbols w/ Indication</th><th>% Up</th>
        <th>Median (bps)</th><th>Mean (bps)</th><th>Std Dev</th>
    </tr></thead><tbody>`;

    VENUE_KEYS.forEach(v => {
        const s = dd.summary && dd.summary[v] ? dd.summary[v] : null;
        if (!s) return;
        html += `<tr>
            <td><span class="venue-dot ${VENUES[v].dotClass}"></span>${VENUES[v].label}</td>
            <td class="mono">${fmtNum(s.symbolsWithIndication)}</td>
            <td class="mono">${fmtPct(s.pctUp)}</td>
            <td class="mono ${bpsClass(s.medianIndicationBps)}">${fmtBps(s.medianIndicationBps)}</td>
            <td class="mono ${bpsClass(s.netIndicationBps)}">${fmtBps(s.netIndicationBps)}</td>
            <td class="mono">${s.stdIndicationBps != null ? s.stdIndicationBps.toFixed(1) : '-'}</td>
        </tr>`;
    });
    html += '</tbody>';
    table.innerHTML = html;
}

// ============================================================================
// SECTION 5: SPREAD & LIQUIDITY
// ============================================================================

function renderSpreadLiquidity(dd) {
    const table = document.getElementById('spreadTable');
    let html = `<thead><tr>
        <th>Venue</th><th>Avg Spread ($)</th>
        <th>Avg Bid Size</th><th>Avg Offer Size</th><th>Notes</th>
    </tr></thead><tbody>`;

    VENUE_KEYS.forEach(v => {
        const s = dd.summary && dd.summary[v] ? dd.summary[v] : null;
        if (!s) return;
        const hasSpread = s.avgSpreadDollars != null;
        html += `<tr>
            <td><span class="venue-dot ${VENUES[v].dotClass}"></span>${VENUES[v].label}</td>
            <td class="mono">${hasSpread ? '$' + s.avgSpreadDollars.toFixed(2) : '-'}</td>
            <td class="mono">${s.avgBidSize != null ? fmtNum(Math.round(s.avgBidSize)) : '-'}</td>
            <td class="mono">${s.avgOfferSize != null ? fmtNum(Math.round(s.avgOfferSize)) : '-'}</td>
            <td style="color:var(--text-muted);font-size:0.78rem">${hasSpread ? '' : 'Spread data not available for this venue'}</td>
        </tr>`;
    });
    html += '</tbody>';
    table.innerHTML = html;
}

// ============================================================================
// SECTION 6: CROSS-VENUE OVERLAP
// ============================================================================

function renderOverlap(dd) {
    const ovl = dd.overlap || {};
    const counts = ovl.counts || {};

    // Donut chart
    const ctx = document.getElementById('chartOverlap');
    if (chartInstances.overlap) { try { chartInstances.overlap.destroy(); } catch(e) {} }

    const all3 = counts.all3 || 0;
    const twoVenues = counts.twoVenues || 0;
    const oneVenue = counts.oneVenue || 0;

    chartInstances.overlap = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['All 3 Venues', '2 Venues', '1 Venue Only'],
            datasets: [{
                data: [all3, twoVenues, oneVenue],
                backgroundColor: ['#f5a623', '#42a5f5', '#555566'],
                borderColor: '#141418',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#8a8a96',
                        font: { family: 'Outfit', size: 11 },
                        padding: 16
                    }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                            const pct = total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0;
                            return `${ctx.label}: ${fmtNum(ctx.raw)} symbols (${pct}%)`;
                        }
                    }
                }
            }
        }
    });

    // Overlap stats
    const statsEl = document.getElementById('overlapStats');
    const total = counts.total || 0;

    // Build pairwise breakdown
    const boatsBruce = ovl.boatsBruce ? ovl.boatsBruce.length : 0;
    const boatsMoon = ovl.boatsMoon ? ovl.boatsMoon.length : 0;
    const bruceMoon = ovl.bruceMoon ? ovl.bruceMoon.length : 0;
    const boatsOnly = ovl.boatsOnly ? ovl.boatsOnly.length : 0;
    const bruceOnly = ovl.bruceOnly ? ovl.bruceOnly.length : 0;
    const moonOnly = ovl.moonOnly ? ovl.moonOnly.length : 0;

    let statsHtml = `<table class="venue-table">
        <thead><tr><th>Category</th><th>Symbols</th><th>% of Total</th></tr></thead>
        <tbody>
            <tr>
                <td style="font-weight:500; color:var(--amber)">All 3 venues</td>
                <td class="mono">${fmtNum(all3)}</td>
                <td class="mono">${total > 0 ? fmtPct(all3 / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>BlueOcean + Bruce only</td>
                <td class="mono">${fmtNum(boatsBruce)}</td>
                <td class="mono">${total > 0 ? fmtPct(boatsBruce / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>BlueOcean + Moon only</td>
                <td class="mono">${fmtNum(boatsMoon)}</td>
                <td class="mono">${total > 0 ? fmtPct(boatsMoon / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Bruce + Moon only</td>
                <td class="mono">${fmtNum(bruceMoon)}</td>
                <td class="mono">${total > 0 ? fmtPct(bruceMoon / total * 100) : '-'}</td>
            </tr>
            <tr style="border-top: 1px solid var(--card-border)">
                <td>BlueOcean only</td>
                <td class="mono">${fmtNum(boatsOnly)}</td>
                <td class="mono">${total > 0 ? fmtPct(boatsOnly / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Bruce only</td>
                <td class="mono">${fmtNum(bruceOnly)}</td>
                <td class="mono">${total > 0 ? fmtPct(bruceOnly / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Moon only</td>
                <td class="mono">${fmtNum(moonOnly)}</td>
                <td class="mono">${total > 0 ? fmtPct(moonOnly / total * 100) : '-'}</td>
            </tr>
            <tr style="border-top: 2px solid var(--card-border); font-weight:600">
                <td>Total Unique</td>
                <td class="mono">${fmtNum(total)}</td>
                <td class="mono">100.0%</td>
            </tr>
        </tbody>
    </table>`;

    // Top symbols trading on all 3 venues
    if (ovl.all3 && ovl.all3.length > 0) {
        // Show first 10 symbols on all 3 venues
        const showSyms = ovl.all3.slice(0, 10);
        statsHtml += `<div style="margin-top:16px; color:var(--text-muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:8px;">
            Sample: All 3 Venues (${fmtNum(all3)} total)
        </div>`;
        statsHtml += `<div style="display:flex; flex-wrap:wrap; gap:6px;">`;
        showSyms.forEach(idx => {
            statsHtml += `<span style="
                background: var(--amber-dim); color: var(--amber);
                padding: 3px 10px; border-radius: 4px;
                font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
            ">${sym(idx)}</span>`;
        });
        if (ovl.all3.length > 10) {
            statsHtml += `<span style="color:var(--text-muted); font-size:0.8rem; padding:3px 6px;">
                +${fmtNum(ovl.all3.length - 10)} more
            </span>`;
        }
        statsHtml += '</div>';
    }

    statsEl.innerHTML = statsHtml;
}

// ============================================================================
// SECTION 7: HISTORICAL TREND
// ============================================================================

function renderHistorical() {
    const section = document.getElementById('historicalSection');
    const dates = Object.keys(DATA).sort();

    if (dates.length < 5) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';
    const el = document.getElementById('chartHistorical');

    // Build traces: daily notional per venue
    const traces = [];

    VENUE_KEYS.forEach(v => {
        const x = [];
        const y = [];
        dates.forEach(d => {
            const s = DATA[d] && DATA[d].summary && DATA[d].summary[v];
            if (s && s.notional > 0) {
                x.push(d);
                y.push(s.notional / 1e9);
            }
        });
        if (x.length > 0) {
            traces.push({
                x: x,
                y: y,
                name: VENUES[v].label,
                type: 'scatter',
                mode: 'lines+markers',
                line: { color: VENUES[v].color, width: 2 },
                marker: { size: 5, color: VENUES[v].color },
                hovertemplate: VENUES[v].label + '<br>%{x}<br>$%{y:.2f}B<extra></extra>'
            });
        }
    });

    const layout = {
        ...PLOTLY_LAYOUT,
        xaxis: {
            ...PLOTLY_LAYOUT.xaxis,
            type: 'date'
        },
        yaxis: {
            ...PLOTLY_LAYOUT.yaxis,
            title: { text: 'Notional ($B)', font: { size: 11, color: '#8a8a96' } }
        },
        legend: { ...PLOTLY_LAYOUT.legend },
        height: 350
    };

    Plotly.newPlot(el, traces, layout, PLOTLY_CONFIG);
    plotlyCharts.push('chartHistorical');
}

// ============================================================================
// DISCLAIMER
// ============================================================================

function renderDisclaimer() {
    const dates = Object.keys(DATA).sort();
    const startDate = dates[0] || 'N/A';
    const endDate = dates[dates.length - 1] || 'N/A';

    document.getElementById('disclaimer').innerHTML = `
        <strong>Disclaimer:</strong> This analysis constitutes independent research on market microstructure
        and is not intended as investment advice. Past performance does not guarantee
        future results. All statistics are observational and based on historical data
        from ${formatDateDisplay(startDate)} to ${formatDateDisplay(endDate)}.
        Sapinover LLC is retained by BlueOcean ATS on a flat monthly fee for research services
        and does not receive transaction-based compensation. No investment recommendations are made herein.
        <br><br>
        <strong>Overnight Indication:</strong> Calculated as (Session VWAP &minus; Prior Close) / Prior Close &times; 10,000
        in basis points. This metric reflects the directional movement observed during the overnight
        session relative to the prior regular-hours close. It is a same-day observational measure
        and does not incorporate next-day market outcomes.
        <br><br>
        <em>Data covers ${fmtNum(dates.length)} session date${dates.length !== 1 ? 's' : ''} across 3 ATS venues.
        Spread and depth data not available for all venues.</em>
    `;
}
