# CLAUDE.md — Sapinover Overnight Dashboard Intelligence

## Project Identity

- **Repo:** `sapinover-overnight-dashboard`
- - **Owner:** Sapinover LLC | ejcacciatore
  - - **Live URL:** [ejcacciatore.github.io/sapinover-overnight-dashboard](https://ejcacciatore.github.io/sapinover-overnight-dashboard)
    - - **Purpose:** Password-protected interactive research dashboard analyzing overnight equity trading in Alternative Trading Systems (ATS)
      - - **Client:** BlueOcean ATS (flat monthly research fee — no transaction-based compensation)
        - - **Academic Foundation:** Lou, Polk & Skouras (2019) — "A tug of war: Overnight versus intraday expected returns" (Journal of Financial Economics)
         
          - ---

          ## Current Dataset

          | Metric | Value |
          |--------|-------|
          | Trading days | 84 (Sep 2, 2025 – Mar 4, 2026) |
          | Observations | ~60,955+ |
          | Unique symbols | 3,272 |
          | Total notional | $194.2B+ |
          | Daily average | ~$2.46B |
          | Asset mix | ~36,652 stock + ~24,217 ETF observations |
          | Price continuity rate | 68.3% |
          | Data source | BOATS (BlueOcean ATS) xlsx files |
          | Institutional filter | $50K minimum notional per observation |

          **Data is updated regularly.** When updating, always update `data.enc`, `venue-overview.enc`, and `metrics-guide.enc` simultaneously.

          ---

          ## Architecture — Critical Context

          This is a **static HTML + vanilla JS dashboard** deployed via GitHub Pages. There is NO backend, NO framework, NO build step.

          ### File Map

          | File | Size | Purpose |
          |------|------|---------|
          | `index.html` | ~5.5 KB | Dashboard shell — 12 tabs, login overlay, decryption script |
          | `dashboard.js` | ~174 KB (3,829 lines) | ALL chart/table/clustering/rendering logic |
          | `styles.css` | ~39 KB | Dark theme styling |
          | `data.enc` | ~8.7 MB | AES-256-GCM encrypted dataset (was `data.json`) |
          | `metrics-guide.html` | ~46 KB | Standalone metrics explanation with worked examples |
          | `metrics-guide.enc` | encrypted | Encrypted metrics guide content |
          | `venue-overview.html` | ~22 KB (557 lines) | Session Overview page — 3-venue pre-market indication |
          | `venue-overview.js` | JS | Session overview rendering logic |
          | `venue-overview.enc` | encrypted | Encrypted venue overview data |
          | `FullLogo_NoBuffer__1_.png` | 14 KB | Sapinover logo |
          | `README.md` | | Public-facing documentation |

          ### CDN Dependencies

          - Chart.js 4.4.1 — bar/line/radar charts
          - - Plotly.js 2.26.0 — scatter, heatmaps, distributions
            - - Font Awesome 6.4.0 — icons
              - - Google Fonts: Outfit, Source Serif 4, JetBrains Mono
               
                - ---

                ## Encryption System — CRITICAL

                All data is encrypted at rest using **AES-256-GCM** with **PBKDF2** key derivation. This is the most important architectural pattern to understand.

                ### How It Works

                1. Data files are encrypted offline into `.enc` files (base64-encoded)
                2. 2. The `.enc` file contains: `salt (16 bytes) + iv (12 bytes) + ciphertext + GCM tag`
                   3. 3. User enters password on login overlay
                      4. 4. Browser derives key via PBKDF2 (100,000 iterations, SHA-256)
                         5. 5. Browser decrypts AES-256-GCM ciphertext in-memory
                            6. 6. Decrypted JSON is passed to `window.initDashboard(json)`
                               7. 7. Password is cached in `sessionStorage` as `sp_auth` for session persistence
                                 
                                  8. ### Encryption Parameters
                                 
                                  9. ```
                                     Algorithm: AES-256-GCM
                                     Key Derivation: PBKDF2
                                     Iterations: 100,000
                                     Hash: SHA-256
                                     Salt: 16 bytes (random per encryption)
                                     IV: 12 bytes (random per encryption)
                                     ```

                                     ### Rules

                                     - **NEVER commit unencrypted `data.json` to this repo** — only `.enc` files
                                     - - **NEVER expose the password** in code, commits, or comments
                                       - - **NEVER include the SHA-256 hash** of the password (was removed in commit 7c652b9)
                                         - - When updating data: encrypt locally, commit only the `.enc` file
                                           - - The login overlay is inline in `index.html` (not in `dashboard.js`)
                                             - - Session auth uses `sessionStorage` (not `localStorage`) — clears on tab close
                                              
                                               - ---

                                               ## Dashboard JavaScript Architecture

                                               `dashboard.js` is a single 3,829-line file with the following structure:

                                               ### Global State Variables

                                               ```javascript
                                               let DATA = null;           // Full parsed dataset
                                               let FILTERED_DATA = [];    // Currently filtered view
                                               let LOOKUP = null;         // Symbol/sector lookup tables
                                               let META = null;           // Dataset metadata

                                               let CURRENT_TAB = 'summary';
                                               let USE_WINSORIZED = true;
                                               let SELECTED_DATE = null;

                                               let EXPLORER_PAGE = 1;
                                               let EXPLORER_SORT = { column: 'notional', ascending: false };
                                               let EXPLORER_FILTERS = { symbol: '', sector: 'all', assetType: 'all', gapDirection: 'all' };
                                               const ROWS_PER_PAGE = 50;

                                               let chartInstances = {};   // Chart.js instances (for cleanup)

                                               let CLUSTER_STATE = { k: 4, features: ['capturedAlpha', 'refGap', 'notional'], results: null };
                                               let SCREENER_STATE = { ... };
                                               ```

                                               ### Entry Point

                                               `window.initDashboard(json)` — called after successful decryption. This:
                                               1. Parses the compressed array format into row objects
                                               2. 2. Builds lookup tables for symbols and sectors
                                                  3. 3. Calculates metadata (date range, totals)
                                                     4. 4. Renders the Summary tab
                                                        5. 5. Sets up tab navigation event listeners
                                                          
                                                           6. ### Tab Rendering Pattern
                                                          
                                                           7. Each tab has a dedicated render function called on tab switch:
                                                           8. - `renderSummary()` — headline stats, daily notional/volume charts, price continuity
                                                              - - `renderDaily()` — per-session breakdown with sortable metrics table
                                                                - - `renderStructure()` — asset type and sector composition (pie/bar)
                                                                  - - `renderQuadrant()` — timing differential vs. reference gap scatter (Plotly)
                                                                    - - `renderExplorer()` — paginated data browser with search/filter
                                                                      - - `renderClustering()` — K-Means++ with configurable features
                                                                        - - `renderCorrelation()` — Pearson correlation matrix, sector heatmap, day-of-week
                                                                          - - `renderRisk()` — distribution analysis, outlier detection
                                                                            - - `renderTimeseries()` — regime identification across sample period
                                                                              - - `renderScreener()` — symbol-level screening with multi-factor filters
                                                                                - - `renderAsiaSleeps()` — cross-session timing relative to Asian market hours
                                                                                  - - `renderMethodology()` — technical documentation (inline)
                                                                                   
                                                                                    - ### Chart Instance Management
                                                                                   
                                                                                    - Charts are tracked in `chartInstances = {}` and **must be destroyed before re-rendering** to prevent memory leaks:
                                                                                    - ```javascript
                                                                                    if (chartInstances['someChart']) chartInstances['someChart'].destroy();
                                                                                    chartInstances['someChart'] = new Chart(ctx, config);
                                                                                    ```

                                                                                    ---

                                                                                    ## Key Metrics — Definitions

                                                                                    ### Timing Differential (bps)
                                                                                    ```
                                                                                    Timing Differential = (Next_Open - VWAP) / Prior_Close × 10,000
                                                                                    ```
                                                                                    Measures the gap between overnight VWAP execution and next-day open. Positive = open exceeded VWAP. Negative = open was below.

                                                                                    ### Reference Gap (bps)
                                                                                    ```
                                                                                    Reference Gap = (VWAP - Prior_Close) / Prior_Close × 10,000
                                                                                    ```
                                                                                    Price movement from prior close to overnight VWAP.

                                                                                    ### Captured Alpha (bps)
                                                                                    Direction-adjusted timing differential. Renamed from "Captured Alpha" — use `capturedAlpha` in code, display as "Captured Alpha" in UI.

                                                                                    ### Overnight Drift (bps)
                                                                                    The full close-to-open movement. Equal to Reference Gap + Timing Differential. **Handle null values** — some rows may have null Overnight Drift when Next_Open data is unavailable.

                                                                                    ### Directional Consistency
                                                                                    Whether the overnight VWAP landed between prior close and next open. ~68.3% in current sample.

                                                                                    ### Price Continuity Rate
                                                                                    Percentage of observations where overnight price action continued in the same direction at the open.

                                                                                    ---

                                                                                    ## Data Format

                                                                                    The encrypted JSON uses a **compressed array format with lookup tables** to minimize file size:

                                                                                    ```json
                                                                                    {
                                                                                      "meta": { "generated": "...", "tradingDays": 84, ... },
                                                                                      "lookups": {
                                                                                        "symbols": ["AAPL", "MSFT", ...],
                                                                                        "sectors": ["Technology", "Healthcare", ...]
                                                                                      },
                                                                                      "columns": ["date", "symbolIdx", "sectorIdx", "volume", "notional", "vwap", ...],
                                                                                      "data": [
                                                                                        ["2025-09-02", 0, 0, 1500, 285000, 190.00, ...]
                                                                                      ]
                                                                                    }
                                                                                    ```

                                                                                    Symbol and sector values are stored as integer indices into the lookup arrays. The `initDashboard` function decompresses these into full row objects.

                                                                                    ---

                                                                                    ## Venue Overview Page

                                                                                    `venue-overview.html` + `venue-overview.js` is a separate page (linked from dashboard footer) that provides:

                                                                                    - 3-venue pre-market indication analysis
                                                                                    - Session-level summary statistics
                                                                                    - - Scatter plots and sector heatmaps
                                                                                      - - Dynamic session summary narrative
                                                                                        - - Also password-protected (reads from `venue-overview.enc`)
                                                                                          - - Uses `postMessage` for iframe embed height reporting (embedded in sapinover-project site)
                                                                                            - - **Venue names are anonymized** across all public-facing outputs (commit 10a76c8)
                                                                                              - 
                                                                                              ---

                                                                                              ## Sapinover Ecosystem — Related Repos

                                                                                              | Repo | Purpose | Relationship |
                                                                                              |------|---------|-------------|
                                                                                              | `sapinover-project` (private) | Main Sapinover site on Vercel (Next.js 14) | Embeds dashboard pages via iframe |
                                                                                              | `Sapinover_Overnight_Data` | Research & intelligence library | Korean retail market analysis, ATS dashboard HTML |
                                                                                              | `sapinover-overnight-alpha` | Venue database + older dashboard version | Historical reference, BlueOcean JSON data |
                                                                                              | `Sapinover-Overnight-Lunar` | LNY 2026 event study dashboard | Standalone analysis of Asian holiday volume patterns |

                                                                                              ### How This Repo Connects to sapinover-project

                                                                                              The main Sapinover site (`sapinover-project.vercel.app`) has pages that embed content from this dashboard:
                                                                                              - `/overnight-session` — embeds `venue-overview.html` via iframe
                                                                                              - - `/overnight-alpha` — embeds main dashboard
                                                                                                - - `/overnight-drift` — embeds drift analysis
                                                                                                  - - `/session-summary` — embeds session summary
                                                                                                    - - `/market-intelligence` — references dashboard data
                                                                                                      - - All embedded pages use `postMessage` for dynamic height reporting
                                                                                                       
                                                                                                        - ---
                                                                                                        
                                                                                                        ## Data Pipeline — Upstream Process
                                                                                                        
                                                                                                        Raw data flows from BOATS xlsx files through a Python pipeline (`append_to_master.py`, not in this repo):
                                                                                                        
                                                                                                        1. Scan for unprocessed daily BOATS xlsx files
                                                                                                        2. 2. Apply institutional filter ($50K minimum notional)
                                                                                                           3. 3. Enrich with Yahoo Finance market data (Prior Close, Next Open, Next Close)
                                                                                                              4. 4. Calculate derived metrics (timing differential, reference gap, directional consistency, captured alpha, overnight drift)
                                                                                                                 5. 5. Append to master Parquet files
                                                                                                                    6. 6. Generate `data.json`
                                                                                                                       7. 7. Encrypt to `data.enc` using AES-256-GCM
                                                                                                                          8. 8. Commit encrypted file to this repo
                                                                                                                             9. 9. GitHub Pages auto-deploys
                                                                                                                               
                                                                                                                                10. **When Yahoo Finance data is incomplete** (batched fetching needed for 1992/1997 symbols), the pipeline handles this gracefully — but missing Next_Open values will produce null Overnight Drift values in the dashboard.
                                                                                                                               
                                                                                                                                11. ---
                                                                                                                               
                                                                                                                                12. ## Design System
                                                                                                                               
                                                                                                                                13. ### Color Palette (CSS Variables)
                                                                                                                               
                                                                                                                                14. ```css
                                                                                                                                    --bg: #0a0e0a;
                                                                                                                                    --card: #141418;
                                                                                                                                    --card-border: #1e1e24;
                                                                                                                                    --text: #f0f0f2;
                                                                                                                                    --text-muted: #8a8a96;
                                                                                                                                    --amber: #f5a623;          /* Primary accent */
                                                                                                                                    --amber-dim: rgba(245, 166, 35, 0.15);
                                                                                                                                    --green: #4caf50;          /* Positive values */
                                                                                                                                    --green-dim: rgba(76, 175, 80, 0.12);
                                                                                                                                    --red: #ef5350;            /* Negative values */
                                                                                                                                    --red-dim: rgba(239, 83, 80, 0.12);
                                                                                                                                    --blue: #42a5f5;
                                                                                                                                    --purple: #ab47bc;
                                                                                                                                    ```
                                                                                                                                    
                                                                                                                                    ### Typography
                                                                                                                                    
                                                                                                                                    - **Outfit** — primary UI font
                                                                                                                                    - - **Source Serif 4** — headings, editorial elements
                                                                                                                                      - - **JetBrains Mono** — data values, code, monospace displays
                                                                                                                                       
                                                                                                                                        - ### Brand
                                                                                                                                       
                                                                                                                                        - - Logo: `FullLogo_NoBuffer__1_.png`
                                                                                                                                          - - Tagline: "Forward Thinking, Transparent Actions"
                                                                                                                                            - - Style: dark, institutional, intelligence-community aesthetic
                                                                                                                                             
                                                                                                                                              - ---
                                                                                                                                              
                                                                                                                                              ## Common Tasks — How-To
                                                                                                                                              
                                                                                                                                              ### Update Data
                                                                                                                                              
                                                                                                                                              1. Process new BOATS xlsx through Python pipeline
                                                                                                                                              2. 2. Generate new `data.json`
                                                                                                                                                 3. 3. Encrypt: produces `data.enc`, `venue-overview.enc`, `metrics-guide.enc`
                                                                                                                                                    4. 4. Commit all three `.enc` files
                                                                                                                                                       5. 5. Push to main — GitHub Pages auto-deploys
                                                                                                                                                          6. 6. Verify dashboard loads with password
                                                                                                                                                            
                                                                                                                                                             7. ### Add a New Dashboard Tab
                                                                                                                                                            
                                                                                                                                                             8. 1. Add `<button>` to tab nav in `index.html`
                                                                                                                                                                2. 2. Add `case` to tab switch handler in `dashboard.js`
                                                                                                                                                                   3. 3. Create `renderNewTab()` function in `dashboard.js`
                                                                                                                                                                      4. 4. Add container HTML generation in the render function
                                                                                                                                                                         5. 5. Add styles to `styles.css`
                                                                                                                                                                            6. 6. Update chart cleanup in tab switch logic
                                                                                                                                                                              
                                                                                                                                                                               7. ### Fix a Rendering Bug
                                                                                                                                                                              
                                                                                                                                                                               8. 1. Check browser console for errors after decryption
                                                                                                                                                                                  2. 2. Common issues: null values in data fields, chart instances not destroyed, field name mismatches
                                                                                                                                                                                     3. 3. Field names changed over time — `capturedAlpha` is canonical, was previously other names
                                                                                                                                                                                        4. 4. Always handle null/undefined in metric calculations
                                                                                                                                                                                           5. 5. Use `totalWithInd` not `totalWI` for session summary totals (fixed in commit 3652879)
                                                                                                                                                                                             
                                                                                                                                                                                              6. ### Embed in sapinover-project
                                                                                                                                                                                             
                                                                                                                                                                                              7. The dashboard pages communicate height to parent via:
                                                                                                                                                                                              8. ```javascript
                                                                                                                                                                                                 window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*');
                                                                                                                                                                                                 ```
                                                                                                                                                                                                 The sapinover-project site listens for these messages to auto-resize iframes.
                                                                                                                                                                                                 
                                                                                                                                                                                                 ---
                                                                                                                                                                                                 
                                                                                                                                                                                                 ## Never Do
                                                                                                                                                                                                 
                                                                                                                                                                                                 - Never commit unencrypted data files (`data.json`) to this repo
                                                                                                                                                                                                 - - Never expose the dashboard password in any file or commit
                                                                                                                                                                                                   - - Never include password hashes in client-side code
                                                                                                                                                                                                     - - Never use `localStorage` for auth (use `sessionStorage` only)
                                                                                                                                                                                                       - - Never reference real venue names in public-facing code — all venues are anonymized
                                                                                                                                                                                                         - - Never modify the PBKDF2 iteration count without re-encrypting all `.enc` files
                                                                                                                                                                                                         - Never skip chart instance cleanup — causes memory leaks and rendering artifacts
                                                                                                                                                                                                         - - Never assume all data fields are non-null — always guard against null Overnight Drift, null Next_Open
                                                                                                                                                                                                          
                                                                                                                                                                                                           - ---
                                                                                                                                                                                                           
                                                                                                                                                                                                           ## Version History — Key Milestones
                                                                                                                                                                                                           
                                                                                                                                                                                                           | Date | Milestone |
                                                                                                                                                                                                           |------|-----------|
                                                                                                                                                                                                           | Feb 25, 2026 | v10 dashboard launched — 12 tabs, full microstructure analysis |
                                                                                                                                                                                                           | Feb 25, 2026 | Added password protection and AES-256-GCM encryption |
                                                                                                                                                                                                           | Feb 25, 2026 | Added README with dataset summary and metrics documentation |
                                                                                                                                                                                                           | Feb 26, 2026 | Fixed Captured Alpha to be direction-adjusted |
                                                                                                                                                                                                           | Mar 2, 2026 | Updated data through 82 trading days |
                                                                                                                                                                                                           | Mar 3, 2026 | Added Overnight Session Overview (venue-overview.html) — 3-venue pre-market indication |
                                                                                                                                                                                                           | Mar 3, 2026 | Anonymized venue names across all public-facing outputs |
                                                                                                                                                                                                           | Mar 3, 2026 | Added Phase 2 (combined watchlist) and Phase 3 (scatter + sector heatmap) to venue overview |
                                                                                                                                                                                                           | Mar 4, 2026 | Updated data through 84 trading days |
                                                                                                                                                                                                           | Mar 4, 2026 | Fixed null Overnight Drift values and renamed from Captured Alpha |
                                                                                                                                                                                                           | Mar 4, 2026 | Added dynamic session summary and iframe embed height reporting |
                                                                                                                                                                                                           
                                                                                                                                                                                                           ---
                                                                                                                                                                                                           
                                                                                                                                                                                                           *Last updated: March 5, 2026*
