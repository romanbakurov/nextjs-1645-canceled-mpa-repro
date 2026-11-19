# Next.js 16.4.5 — canceled MPA cannot be retried

**Independent, minimal reproduction candidate.** This directory does not contain Vellira code, custom Next.js patches, Cloudflare, or security credentials. The scripts have been syntax-checked, and this standalone fixture has been confirmed in Playwright WebKit on stock Next.js 16.4.5 and 16.5.0-canary.56. Normal navigation works; retries after HTTP 204 and dismissed beforeunload remain stuck.

## Setup (macOS/Linux, Node.js 22+)

```sh
npm install
npx playwright install webkit
npm run repro
```

The runner builds a production Next app with two separate root layouts (`/a` and `/b`), starts Next on localhost, and forwards normal traffic through a temporary local HTTP proxy on a second localhost port.

## Scenarios

1. **Normal control:** click `<Link href="/b" prefetch={false}>` on `/a` and verify a real cross-document transition into `/b`.
2. **HTTP 204:** on the first native `/b` HTML navigation request only, the proxy replies `204 No Content` (no Playwright request interception). Confirm old `/a` document survives, allow the next `/b` HTML request, click the same link again; record whether it transitions.
3. **Dismissed beforeunload:** install a native `beforeunload` handler on `/a`, dismiss the real browser dialog via Playwright, remove handler, click the same link again; record whether it transitions.

Output saved under `evidence/`, including `summary.json`, browser request/navigation/error events, and Next production build/start logs. It does **not** override fetch, suppress JavaScript errors, alter Next internals, or use timers to recover application state. The diagnostic sleeps are observation delays only.

## Interpretation

- `normal-hard-navigation-ok` is needed before canceled-MPA comparisons are meaningful.
- `retry-stuck` means the new HTML navigation did not complete; review the JSON events before claiming a Next.js bug.
- `inconclusive-no-confirmed-cancellation` is not PASS.
- Repeat on latest canary before submitting an upstream bug if possible; this fixture pins 16.4.5 to mirror the original report.
- If `beforeunload` dialogs are suppressed by the browser, mark that case inconclusive.

Upstream GitHub issues require a *public repository link*. Publish this standalone folder only after verifying it runs, and use the resulting URL in the issue template.
