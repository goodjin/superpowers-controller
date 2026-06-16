# Bug Fix: Superagent Dynamic Import Fetch Error

## Problem

- Date: 2026-06-16
- Severity: Medium
- Scope: isolated Superagent Web runtime

Opening a project in the Web UI could show:

```text
TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:5096/assets/session-BXsNB1I-.js
```

## Root Cause

The requested chunk existed and `GET /assets/session-BXsNB1I-.js` returned the full JavaScript body. The failure was caused by the restart script reporting success as soon as a listener appeared, before verifying that the Web app shell and entry assets were ready. A browser tab that opened or resumed during this restart window could keep a failed dynamic import state until refreshed.

## Fix

- Updated `scripts/deploy-superagent-runtime.sh`.
- `start_server()` now waits for the Web app root HTML to reference an entry asset.
- The script then fetches the entry JavaScript and requires a non-empty payload before declaring restart success.

## Validation

1. Ran `scripts/deploy-superagent-runtime.sh restart`.
2. Confirmed `http://127.0.0.1:5096` is running.
3. Used Playwright to open the Web UI, click `/Users/jin/github/opencode-superpowers`, and wait on the project session page.
4. Verified no `pageerror` or failed asset requests were reported.
