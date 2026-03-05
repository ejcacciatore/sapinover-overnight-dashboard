# CLAUDE.md — sapinover-overnight-dashboard

## What This Is
Password-protected ATS microstructure research dashboard deployed on GitHub Pages. Data is AES-256-GCM encrypted client-side. Embedded into sapinover-project (Vercel) via iframe.

See ARCHITECTURE.md in sapinover-project for the full cross-repo ecosystem map.

## Live URL
https://ejcacciatore.github.io/sapinover-overnight-dashboard

## Repo Structure
```
sapinover-overnight-dashboard/
├── index.html                    # Main dashboard shell (12 tabs)
├── dashboard.js                  # v3.0 controller (3,829 lines)
│                                 #   k-means clustering, heatmaps, regime analysis
├── styles.css                    # Dashboard styling
├── data.enc                      # AES-256-GCM encrypted dataset
├── venue-overview.html           # 3-venue session overview page
├── venue-overview.js             # Venue overview controller
├── venue-overview.enc            # Encrypted venue overview data
├── metrics-guide.html            # Methodology documentation
├── metrics-guide.enc             # Encrypted guide content
├── metrics-guide-content.html    # Source content (encrypted at deploy)
├── CLAUDE.md                     # THIS FILE
└── README.md                     # Public-facing summary
```

## Authentication
- Password: Alpha$2026
- Flow: user enters password -> PBKDF2 key derivation (100K iterations) -> AES-256-GCM decrypt -> data loads
- sessionStorage shares auth state between dashboard and metrics guide within same browser session
- Encryption performed by `encrypt_data.py` in the Overnight_Session_Data pipeline (Google Drive)

## Dashboard Tabs (12)
Summary | Daily | Structure | Quadrant | Clustering | Heatmaps | Explorer | Risk | Regimes | Screener | Asia Sleeps | Methodology

## data.json / data.enc Format

Compressed array format with lookup tables. Each data row has exactly 24 fields:

```
row[0]  = sym_idx (symbol lookup)     row[12] = timingDiff (bps)
row[1]  = company_idx (company lookup) row[13] = timingDiffW (winsorized)
row[2]  = date_idx (date lookup)      row[14] = refGap (bps)
row[3]  = assetType (1=ETF, 0=Stock)  row[15] = refGapW (winsorized)
row[4]  = sector_idx (sector lookup)  row[16] = totalGap (bps)
row[5]  = notional                    row[17] = gapDirection (1=UP, 0=DOWN)
row[6]  = volume                      row[18] = dirConsistency (1=true)
row[7]  = executions                  row[19] = isOutlier (1=true)
row[8]  = vwap                        row[20] = marketCap
row[9]  = priorClose                  row[21] = leverageMult
row[10] = nextOpen                    row[22] = capturedAlpha (bps)
row[11] = nextClose                   row[23] = capturedAlphaW (winsorized)
```

**Critical**: dashboard.js v3.0 expects exactly 24 fields per row. Missing fields [22] and [23] will break Clustering, Heatmaps, and other advanced tabs silently (basic tabs still render).

## dashboard.js Key Functions
- Data parsing: maps row arrays to named objects using LOOKUP tables
- `getCapturedAlpha()`: returns winsorized or raw capturedAlpha based on toggle
- k-means clustering with configurable features and K
- Correlation heatmap across 7 metrics
- Regime detection based on volatility/volume thresholds
- Screener with multi-filter support

## Venue Overview (venue-overview.html)
Separate page showing 3-venue session data (BlueOcean, Bruce, Moon). Uses venue-overview.enc (same encryption scheme). Includes watchlist functionality and per-symbol overnight indication calculations.

## iframe Embedding
Dashboard reports height to parent via postMessage:
```javascript
window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*');
```
sapinover-project (Vercel) listens and adjusts iframe height dynamically.

## Deployment Cycle
Data originates from the Overnight_Session_Data pipeline (Google Drive). Deployment steps:

```bash
# In Overnight_Session_Data directory:
python append_to_master.py --skip-today          # Pipeline: enrich + append
python generate_venue_overview.py --date YYYY-MM-DD  # 3-venue overview
cd BlueOcean && python encrypt_data.py           # Encrypt data.json + guide

# Copy encrypted files to this repo:
cp data.enc venue-overview.enc metrics-guide.enc /path/to/sapinover-overnight-dashboard/

# Deploy:
cd /path/to/sapinover-overnight-dashboard
git add -A && git commit -m "Update data YYYY-MM-DD" && git push
# GitHub Pages auto-deploys
```

## Current Dataset
- ~84+ trading days (Sep 2025 through Mar 2026)
- 60,955+ observations
- $194.2B+ total notional
- 3,272+ unique symbols
- BlueOcean ATS data only (institutional filter: $50K minimum notional)

## Libraries (CDN-hosted)
- Chart.js (visualizations)
- Plotly (3D charts, heatmaps)
- Font Awesome (icons)

## Known Issues
- file:// protocol breaks data loading (CORS blocks fetch). Must use localhost HTTP server for local testing
- GitHub Pages cache can serve stale files after push. Hard refresh (Ctrl+Shift+R) clears it
- NaN values in data.json break JSON.parse. Pipeline's sanitize_row() converts NaN/Inf to null

## FINRA/SEC Compliance
Same rules as sapinover-project. Never use: bullish, bearish, risk-on, risk-off, drift, alpha in user-facing labels. Use: timing differential, overnight indication, positioning.

## Related
- Pipeline source: Overnight_Session_Data/CLAUDE.md (Google Drive)
- Parent site: sapinover-project/CLAUDE.md
- Encryption script: Overnight_Session_Data/BlueOcean/encrypt_data.py

---
*Last updated: March 5, 2026*
