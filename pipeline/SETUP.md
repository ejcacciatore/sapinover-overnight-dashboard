# Pipeline Setup (GitHub Actions)

## GitHub Secrets Required

Go to: **Settings > Secrets and variables > Actions** in the `sapinover-overnight-dashboard` repo.

Add these secrets:

### Required
| Secret | Description |
|--------|-------------|
| `ENCRYPT_PASSWORD` | AES-256-GCM encryption password (matches SUBSCRIBER_PASSWORD on Vercel) |

### BOATS (BlueOcean ATS) — Gmail IMAP
| Secret | Description |
|--------|-------------|
| `GMAIL_ADDRESS` | Gmail address for BOATS email |
| `GMAIL_APP_PASSWORD` | Gmail App Password (not regular password) |

### Bruce Markets — SFTP
| Secret | Description |
|--------|-------------|
| `BRUCE_SFTP_HOST` | `ftp-brucemarkets.egnyte.com` |
| `BRUCE_SFTP_PORT` | `22` |
| `BRUCE_SFTP_USER` | `calcguard$brucemarkets` |
| `BRUCE_SFTP_PASSWORD` | SFTP password |

### Bruce Markets — Egnyte API (fallback)
| Secret | Description |
|--------|-------------|
| `EGNYTE_DOMAIN` | `brucemarkets` |
| `EGNYTE_ACCESS_TOKEN` | Egnyte API token |

### BOATS — Microsoft Graph API (fallback)
| Secret | Description |
|--------|-------------|
| `GRAPH_TENANT_ID` | Azure AD tenant ID |
| `GRAPH_CLIENT_ID` | App registration client ID |
| `GRAPH_CLIENT_SECRET` | App registration secret |
| `GRAPH_USER_EMAIL` | `ecacciatore@calcguard.com` |

### Supabase (status reporting)
| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |

## Additional Scripts Needed

Copy these from Google Drive to `pipeline/`:

```
G:\My Drive\Colab Notebooks\Overnight_Session_Data\append_to_combined_master.py
G:\My Drive\Colab Notebooks\Overnight_Session_Data\generate_venue_overview.py
```

**Important:** In `append_to_combined_master.py`, change line 44:
```python
# FROM:
BASE_DIR = r"G:\My Drive\Colab Notebooks\Overnight_Session_Data"
# TO:
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
```

You'll also need:
- `BlueOcean/BlueOcean_Symbol_Master.csv` (symbol metadata)
- Any existing master parquet files if you want continuity

## Schedule

The workflow runs automatically at **9:15 AM ET Mon-Fri**.
You can also trigger manually from the Actions tab.

## Coexistence with Task Scheduler

Both can run simultaneously. The pipeline checks for existing files before
pulling, so duplicate runs are safe. GitHub Actions serves as a reliable
cloud backup when your local machine is off.
