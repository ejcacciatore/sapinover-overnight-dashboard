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

// Venue config (anonymized per FINRA 2241 / venue anonymity requirements)
const VENUES = {
    venue1: { label: 'Venue 1', color: '#f5a623', colorDim: 'rgba(245,166,35,0.15)', dotClass: 'dot-v1' },
    venue2: { label: 'Venue 2', color: '#42a5f5', colorDim: 'rgba(66,165,245,0.15)', dotClass: 'dot-v2' },
    venue3: { label: 'Venue 3', color: '#ab47bc', colorDim: 'rgba(171,71,188,0.15)', dotClass: 'dot-v3' }
};
const VENUE_KEYS = ['venue1', 'venue2', 'venue3'];

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
    renderWatchlist(dd);
    renderScatterPlot(dd);
    renderSectorHeatmap(dd);
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

    // Check for historical average (Venue 1 carries the parquet-based avg)
    const v1Avg = s.venue1 && s.venue1.notionalVsAvg ? s.venue1.notionalVsAvg : null;
    const vsAvgLabel = v1Avg != null
        ? `${v1Avg.toFixed(2)}x`
        : '-';
    const vsAvgCls = v1Avg != null
        ? (v1Avg >= 1.2 ? 'up' : v1Avg <= 0.8 ? 'down' : '')
        : '';

    const kpis = [
        { value: fmtDollar(totalNotional), label: 'Total Notional', cls: '' },
        { value: fmtNum(totalVolume), label: 'Total Share Volume', cls: '' },
        { value: fmtNum(totalTrades), label: 'Total Trades', cls: '' },
        { value: fmtNum(uniqueSymbols), label: 'Unique Symbols', cls: '' },
        {
            value: vsAvgLabel,
            label: 'Venue 1 vs 20d Avg',
            cls: vsAvgCls
        },
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
        <th>Trades</th><th>Symbols</th><th>% of Total</th><th>vs 20d Avg</th>
    </tr></thead><tbody>`;

    const totalNotional = VENUE_KEYS.reduce((sum, v) => sum + (s[v] ? s[v].notional || 0 : 0), 0);

    VENUE_KEYS.forEach(v => {
        if (!s[v] || s[v].notional === 0) return;
        const pct = totalNotional > 0 ? (s[v].notional / totalNotional * 100) : 0;
        const vsAvg = s[v].notionalVsAvg;
        const vsAvgStr = vsAvg != null ? vsAvg.toFixed(2) + 'x' : '-';
        const vsAvgCls = vsAvg != null ? (vsAvg >= 1.2 ? 'val-pos' : vsAvg <= 0.8 ? 'val-neg' : '') : '';
        html += `<tr>
            <td><span class="venue-dot ${VENUES[v].dotClass}"></span>${VENUES[v].label}</td>
            <td class="mono">${fmtDollar(s[v].notional)}</td>
            <td class="mono">${fmtNum(s[v].volume)}</td>
            <td class="mono">${fmtNum(s[v].trades)}</td>
            <td class="mono">${fmtNum(s[v].symbols)}</td>
            <td class="mono">${fmtPct(pct)}</td>
            <td class="mono ${vsAvgCls}">${vsAvgStr}</td>
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
            <th>#</th><th>Symbol</th><th>Notional</th><th>VWAP</th><th>Indication</th><th>vs Avg</th>
        </tr></thead><tbody>`;

        tickers.forEach((row, i) => {
            // [symIdx, notional, volume, trades, vwap, indicationBps, relNotional, relVolume]
            const [symIdx, notional, volume, trades, vwap, indBps, relNot, relVol] = row;
            const relStr = relNot != null ? relNot.toFixed(1) + 'x' : '-';
            const relCls = relNot != null ? (relNot >= 2.0 ? 'val-pos' : relNot <= 0.5 ? 'val-neg' : '') : '';
            html += `<tr>
                <td class="mono" style="color:var(--text-muted)">${i + 1}</td>
                <td style="font-weight:500">${sym(symIdx)}</td>
                <td class="mono">${fmtDollar(notional)}</td>
                <td class="mono">${fmtPrice(vwap)}</td>
                <td class="mono ${bpsClass(indBps)}">${fmtBps(indBps)}</td>
                <td class="mono ${relCls}">${relStr}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        card.innerHTML = html;
        grid.appendChild(card);
    });
}

// ============================================================================
// SECTION 2B: COMBINED WATCHLIST
// ============================================================================

let watchlistState = { data: [], sortCol: 1, sortAsc: false, search: '', venueFilter: 'all', sectorFilter: 'all' };

function renderWatchlist(dd) {
    const raw = dd.watchlist;
    if (!raw || raw.length === 0) return;

    // Format: [symIdx, notional, volume, trades, vwap, indBps, relNotional, sectorIdx, venueFlags]
    watchlistState.data = raw;
    watchlistState.sortCol = 1; // default: notional desc
    watchlistState.sortAsc = false;

    // Populate sector filter dropdown
    const sectorSelect = document.getElementById('watchlistSectorFilter');
    if (sectorSelect) {
        const sectorSet = new Set();
        raw.forEach(r => { if (r[7] >= 0) sectorSet.add(r[7]); });
        const opts = '<option value="all">All Sectors</option>' +
            Array.from(sectorSet).sort((a,b) => sectorName(a).localeCompare(sectorName(b)))
                .map(i => `<option value="${i}">${sectorName(i)}</option>`).join('');
        sectorSelect.innerHTML = opts;
    }

    // Wire up filters
    const searchEl = document.getElementById('watchlistSearch');
    const venueEl = document.getElementById('watchlistVenueFilter');
    const sectorEl = document.getElementById('watchlistSectorFilter');
    if (searchEl) searchEl.oninput = () => { watchlistState.search = searchEl.value.toUpperCase(); renderWatchlistTable(); };
    if (venueEl) venueEl.onchange = () => { watchlistState.venueFilter = venueEl.value; renderWatchlistTable(); };
    if (sectorEl) sectorEl.onchange = () => { watchlistState.sectorFilter = sectorEl.value; renderWatchlistTable(); };

    renderWatchlistTable();
}

function renderWatchlistTable() {
    const { data, sortCol, sortAsc, search, venueFilter, sectorFilter } = watchlistState;

    // Filter
    let rows = data.filter(r => {
        if (search && !sym(r[0]).toUpperCase().includes(search)) return false;
        if (venueFilter !== 'all') {
            const mask = parseInt(venueFilter);
            if (mask === 7) { if (r[8] !== 7) return false; }
            else { if (!(r[8] & mask)) return false; }
        }
        if (sectorFilter !== 'all' && r[7] !== parseInt(sectorFilter)) return false;
        return true;
    });

    // Sort
    const sorted = [...rows].sort((a, b) => {
        let va = a[sortCol], vb = b[sortCol];
        if (va == null) va = sortAsc ? Infinity : -Infinity;
        if (vb == null) vb = sortAsc ? Infinity : -Infinity;
        return sortAsc ? va - vb : vb - va;
    });

    // Limit display to top 200
    const display = sorted.slice(0, 200);
    const countEl = document.getElementById('watchlistCount');
    if (countEl) countEl.textContent = `${display.length} of ${rows.length} symbols`;

    // Column definitions
    const cols = [
        { key: 0, label: 'Symbol', align: 'left' },
        { key: 1, label: 'Notional', align: 'right' },
        { key: 2, label: 'Volume', align: 'right' },
        { key: 5, label: 'Indication', align: 'right' },
        { key: 4, label: 'VWAP', align: 'right' },
        { key: 6, label: 'vs Avg', align: 'right' },
        { key: 7, label: 'Sector', align: 'left' },
        { key: 8, label: 'Venues', align: 'center' },
    ];

    // Build header
    let html = '<thead><tr>';
    cols.forEach(c => {
        const active = sortCol === c.key ? ' active' : '';
        const arrow = sortCol === c.key ? (sortAsc ? '\u25B2' : '\u25BC') : '\u25BC';
        const sortable = c.key === 8 ? '' : ` class="sort-header${active}" onclick="sortWatchlist(${c.key})"`;
        html += `<th style="text-align:${c.align}"${sortable}>${c.label}`;
        if (c.key !== 8) html += ` <span class="sort-arrow">${arrow}</span>`;
        html += '</th>';
    });
    html += '</tr></thead><tbody>';

    // Build rows
    display.forEach(r => {
        const indCls = r[5] != null ? (r[5] >= 0 ? 'val-pos' : 'val-neg') : '';
        const relCls = r[6] != null ? (r[6] >= 2.0 ? 'val-pos' : r[6] <= 0.5 ? 'val-neg' : '') : '';
        const flags = r[8];
        const v1on = flags & 1 ? ' on' : '';
        const v2on = flags & 2 ? ' on' : '';
        const v3on = flags & 4 ? ' on' : '';

        html += '<tr>';
        html += `<td style="text-align:left"><strong>${sym(r[0])}</strong></td>`;
        html += `<td style="text-align:right">${fmtDollar(r[1])}</td>`;
        html += `<td style="text-align:right">${fmtNum(r[2])}</td>`;
        html += `<td style="text-align:right" class="${indCls}">${r[5] != null ? fmtBps(r[5]) : '-'}</td>`;
        html += `<td style="text-align:right">${r[4] != null ? fmtPrice(r[4]) : '-'}</td>`;
        html += `<td style="text-align:right" class="${relCls}">${r[6] != null ? r[6].toFixed(1) + 'x' : '-'}</td>`;
        html += `<td style="text-align:left;font-size:0.75rem;color:var(--text-muted)">${sectorName(r[7])}</td>`;
        html += `<td><div class="venue-dots">`;
        html += `<div class="vd${v1on}" style="background:${VENUES.venue1.color}"></div>`;
        html += `<div class="vd${v2on}" style="background:${VENUES.venue2.color}"></div>`;
        html += `<div class="vd${v3on}" style="background:${VENUES.venue3.color}"></div>`;
        html += `</div></td>`;
        html += '</tr>';
    });

    html += '</tbody>';
    document.getElementById('watchlistTable').innerHTML = html;
}

window.sortWatchlist = function(colKey) {
    if (watchlistState.sortCol === colKey) {
        watchlistState.sortAsc = !watchlistState.sortAsc;
    } else {
        watchlistState.sortCol = colKey;
        // Default sort direction: desc for numbers, asc for text
        watchlistState.sortAsc = (colKey === 0 || colKey === 7);
    }
    renderWatchlistTable();
};


// ============================================================================
// SECTION: NOTIONAL vs INDICATION SCATTER PLOT
// ============================================================================

function renderScatterPlot(dd) {
    const raw = dd.watchlist;
    if (!raw || raw.length === 0) return;

    const el = document.getElementById('chartScatter');

    // Filter to symbols with valid indication and notional > 0
    const valid = raw.filter(r => r[5] != null && r[1] > 0);
    if (valid.length === 0) return;

    // Split by direction for color coding
    const up = valid.filter(r => r[5] >= 0);
    const down = valid.filter(r => r[5] < 0);

    function makeTrace(data, name, color) {
        return {
            x: data.map(r => r[5]),
            y: data.map(r => r[1]),
            text: data.map(r =>
                '<b>' + sym(r[0]) + '</b><br>' +
                fmtDollar(r[1]) + ' notional<br>' +
                fmtBps(r[5]) + '<br>' +
                sectorName(r[7])
            ),
            name: name,
            type: 'scatter',
            mode: 'markers',
            marker: {
                color: color,
                size: data.map(r => {
                    var s = Math.log10(Math.max(r[2], 1)) * 2.5;
                    return Math.max(3, Math.min(16, s));
                }),
                opacity: 0.55,
                line: { width: 0 }
            },
            hovertemplate: '%{text}<extra></extra>'
        };
    }

    var traces = [
        makeTrace(up, 'Positive Indication', 'rgba(76,175,80,0.85)'),
        makeTrace(down, 'Negative Indication', 'rgba(239,83,80,0.85)')
    ];

    var layout = {
        ...PLOTLY_LAYOUT,
        xaxis: {
            ...PLOTLY_LAYOUT.xaxis,
            title: { text: 'Overnight Indication (bps)', font: { size: 11, color: '#8a8a96' } },
            zeroline: true,
            zerolinecolor: 'rgba(245,166,35,0.25)',
            zerolinewidth: 1,
            range: [-350, 350]
        },
        yaxis: {
            ...PLOTLY_LAYOUT.yaxis,
            title: { text: 'Notional ($)', font: { size: 11, color: '#8a8a96' } },
            type: 'log'
        },
        height: 450,
        showlegend: true,
        legend: { ...PLOTLY_LAYOUT.legend, y: -0.18 }
    };

    Plotly.newPlot(el, traces, layout, PLOTLY_CONFIG);
    plotlyCharts.push('chartScatter');
}

// ============================================================================
// SECTION: SECTOR INDICATION HEATMAP
// ============================================================================

function heatColor(bps) {
    // Map indication bps to green (positive) or red (negative) background
    var clamped = Math.max(-150, Math.min(150, bps));
    var intensity = Math.abs(clamped) / 150;
    var alpha = 0.08 + intensity * 0.55;
    if (clamped >= 0) {
        return 'rgba(76, 175, 80, ' + alpha + ')';
    } else {
        return 'rgba(239, 83, 80, ' + alpha + ')';
    }
}

function renderSectorHeatmap(dd) {
    var hm = dd.sectorHeatmap;
    if (!hm) return;

    var container = document.getElementById('sectorHeatmap');
    var venueKeys = ['venue1', 'venue2', 'venue3'];

    // Collect all sectors across all venues
    var sectorData = {};
    venueKeys.forEach(function(v) {
        if (!hm[v]) return;
        hm[v].forEach(function(row) {
            // [sectorIdx, medianInd, meanInd, notional, symCount, pctUp]
            var idx = row[0];
            if (!sectorData[idx]) sectorData[idx] = {};
            sectorData[idx][v] = {
                medianInd: row[1],
                meanInd: row[2],
                notional: row[3],
                count: row[4],
                pctUp: row[5]
            };
        });
    });

    // Sort sectors by total notional descending
    var sectorIdxs = Object.keys(sectorData).map(Number);
    sectorIdxs.sort(function(a, b) {
        var totalA = venueKeys.reduce(function(sum, v) { return sum + (sectorData[a][v] ? sectorData[a][v].notional : 0); }, 0);
        var totalB = venueKeys.reduce(function(sum, v) { return sum + (sectorData[b][v] ? sectorData[b][v].notional : 0); }, 0);
        return totalB - totalA;
    });

    // Build table
    var html = '<table class="venue-table heatmap-table"><thead><tr>';
    html += '<th style="text-align:left">Sector</th>';
    venueKeys.forEach(function(v) {
        html += '<th style="text-align:center"><span class="venue-dot ' + VENUES[v].dotClass + '"></span>' + VENUES[v].label + '</th>';
    });
    html += '<th style="text-align:center;font-weight:600">Combined</th>';
    html += '</tr></thead><tbody>';

    sectorIdxs.forEach(function(idx) {
        html += '<tr>';
        html += '<td style="text-align:left;font-weight:500;white-space:nowrap;font-size:0.82rem">' + sectorName(idx) + '</td>';

        var allWeighted = 0, allCount = 0, allNotional = 0;

        venueKeys.forEach(function(v) {
            var d = sectorData[idx] ? sectorData[idx][v] : null;
            if (d && d.medianInd != null) {
                var bg = heatColor(d.medianInd);
                var sign = d.medianInd >= 0 ? '+' : '';
                html += '<td style="text-align:center;background:' + bg + '"' +
                    ' title="' + d.count + ' symbols | ' + fmtDollar(d.notional) + ' | ' + d.pctUp + '% up">';
                html += '<span style="font-family:\'JetBrains Mono\',monospace;font-size:0.8rem;font-weight:500">' +
                    sign + d.medianInd.toFixed(1) + '</span>';
                html += '<span class="heatmap-unit"> bps</span></td>';

                allWeighted += d.medianInd * d.count;
                allCount += d.count;
                allNotional += d.notional;
            } else {
                html += '<td style="text-align:center;color:var(--text-muted);font-size:0.8rem">&mdash;</td>';
            }
        });

        // Combined column (weighted average of medians)
        if (allCount > 0) {
            var combined = allWeighted / allCount;
            var bg = heatColor(combined);
            var sign = combined >= 0 ? '+' : '';
            html += '<td style="text-align:center;background:' + bg + ';font-weight:600"' +
                ' title="' + allCount + ' symbols | ' + fmtDollar(allNotional) + '">';
            html += '<span style="font-family:\'JetBrains Mono\',monospace;font-size:0.8rem">' +
                sign + combined.toFixed(1) + '</span>';
            html += '<span class="heatmap-unit"> bps</span></td>';
        } else {
            html += '<td style="text-align:center;color:var(--text-muted)">&mdash;</td>';
        }

        html += '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
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

    // Build pairwise breakdown (anonymized keys)
    const v1v2 = ovl.v1v2 ? ovl.v1v2.length : 0;
    const v1v3 = ovl.v1v3 ? ovl.v1v3.length : 0;
    const v2v3 = ovl.v2v3 ? ovl.v2v3.length : 0;
    const v1Only = ovl.v1Only ? ovl.v1Only.length : 0;
    const v2Only = ovl.v2Only ? ovl.v2Only.length : 0;
    const v3Only = ovl.v3Only ? ovl.v3Only.length : 0;

    let statsHtml = `<table class="venue-table">
        <thead><tr><th>Category</th><th>Symbols</th><th>% of Total</th></tr></thead>
        <tbody>
            <tr>
                <td style="font-weight:500; color:var(--amber)">All 3 venues</td>
                <td class="mono">${fmtNum(all3)}</td>
                <td class="mono">${total > 0 ? fmtPct(all3 / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Venue 1 + Venue 2 only</td>
                <td class="mono">${fmtNum(v1v2)}</td>
                <td class="mono">${total > 0 ? fmtPct(v1v2 / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Venue 1 + Venue 3 only</td>
                <td class="mono">${fmtNum(v1v3)}</td>
                <td class="mono">${total > 0 ? fmtPct(v1v3 / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Venue 2 + Venue 3 only</td>
                <td class="mono">${fmtNum(v2v3)}</td>
                <td class="mono">${total > 0 ? fmtPct(v2v3 / total * 100) : '-'}</td>
            </tr>
            <tr style="border-top: 1px solid var(--card-border)">
                <td>Venue 1 only</td>
                <td class="mono">${fmtNum(v1Only)}</td>
                <td class="mono">${total > 0 ? fmtPct(v1Only / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Venue 2 only</td>
                <td class="mono">${fmtNum(v2Only)}</td>
                <td class="mono">${total > 0 ? fmtPct(v2Only / total * 100) : '-'}</td>
            </tr>
            <tr>
                <td>Venue 3 only</td>
                <td class="mono">${fmtNum(v3Only)}</td>
                <td class="mono">${total > 0 ? fmtPct(v3Only / total * 100) : '-'}</td>
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
        Sapinover LLC is retained on a flat monthly fee for research services
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
