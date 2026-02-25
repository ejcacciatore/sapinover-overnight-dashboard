# Sapinover LLC | Overnight ATS Market Microstructure Dashboard

Interactive research dashboard analyzing overnight equity trading in Alternative Trading Systems. Built on 79 trading days of institutional flow data spanning September 2025 through February 2026.

**Live dashboard:** [ejcacciatore.github.io/sapinover-overnight-dashboard](https://ejcacciatore.github.io/sapinover-overnight-dashboard/)

## Dataset

| Metric | Value |
|--------|-------|
| Trading days | 79 (Sep 2, 2025 to Feb 24, 2026) |
| Observations | 60,955 |
| Unique symbols | 3,272 |
| Total notional | $194.2 billion |
| Daily average | $2.46 billion |
| Asset mix | 36,652 stock + 24,217 ETF observations |
| Price continuity rate | 68.3% |

## Dashboard Tabs

| Tab | Description |
|-----|-------------|
| **Summary** | Headline statistics, daily notional/volume charts, price continuity trend |
| **Daily** | Per-session breakdown with sortable metrics table |
| **Structure** | Asset type and sector composition analysis |
| **Quadrant** | Two-dimensional scatterplot of timing differential vs. reference gap |
| **Explorer** | Full observation-level data browser with search and filters |
| **Clustering** | K-Means++ behavioral clustering across configurable feature sets |
| **Heatmaps** | Pearson correlation matrix, sector heatmap, day-of-week effects |
| **Risk** | Distribution analysis of timing differentials and outlier detection |
| **Regimes** | Temporal regime identification across the sample period |
| **Screener** | Symbol-level screening with multi-factor filtering |
| **Asia Sleeps** | Cross-session timing analysis relative to Asian market hours |
| **Methodology** | Technical documentation of all calculations and data sources |

## Metrics Guide

A standalone explanation of every metric used in the dashboard, with formulas, visual diagrams, and four worked examples using real data (AAPL, TSLA, MU, SPY):

[View Metrics Guide](https://ejcacciatore.github.io/sapinover-overnight-dashboard/metrics-guide.html)

## Key Metrics

**Timing Differential (bps):** Measures the gap between overnight VWAP execution and next-day open, normalized by prior close. Positive values indicate the open exceeded the VWAP; negative values indicate the open was below.

```
Timing Differential = (Next_Open - VWAP) / Prior_Close x 10,000
```

**Reference Gap (bps):** The price movement from prior close to overnight VWAP.

```
Reference Gap = (VWAP - Prior_Close) / Prior_Close x 10,000
```

**Directional Consistency:** Whether the overnight VWAP landed between the prior close and next open (68.8% of observations in this sample).

**Total Overnight Gap:** The full close-to-open movement, equal to Reference Gap + Timing Differential.

## Architecture

Static HTML dashboard with no backend dependencies. All data is embedded in `data.json` (compressed array format with lookup tables). Visualization libraries load from CDN:

- Chart.js 4.4.1 (bar/line charts)
- Plotly.js 2.26.0 (scatter, heatmaps, distributions)
- Font Awesome 6.4.0 (icons)
- Google Fonts: Outfit, Source Serif 4, JetBrains Mono

## Files

```
index.html           5.5 KB    Dashboard shell (12 tabs)
dashboard.js         173 KB    Chart/table/clustering logic
styles.css            39 KB    Dark theme styling
data.json            8.7 MB    60,955 rows x 24 fields
metrics-guide.html    46 KB    Metrics explanation with examples
FullLogo_NoBuffer__1_.png  14 KB    Sapinover logo
```

## Data Pipeline

Raw BOATS xlsx files are processed through a Python pipeline (`append_to_master.py`) that:

1. Scans for unprocessed daily files
2. Applies institutional filters ($50K minimum notional)
3. Enriches with Yahoo Finance market data (Prior Close, Next Open, Next Close)
4. Calculates timing differentials, reference gaps, and directional consistency
5. Appends to master Parquet files
6. Regenerates `data.json` for the dashboard

## Research Context

This work builds on the overnight return anomaly documented in Lou, Polk & Skouras (2019), "A tug of war: Overnight versus intraday expected returns" (Journal of Financial Economics, vol 134, pp 192-213).

---

*This analysis constitutes independent research on market microstructure and is not intended as investment advice. Past performance does not guarantee future results. All statistics are observational and based on historical data from 2025-09-02 to 2026-02-24. Sapinover LLC is retained by BlueOcean ATS on a flat monthly fee for research services and does not receive transaction-based compensation. No investment recommendations are made herein.*
