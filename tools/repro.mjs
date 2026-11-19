import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, firefox, webkit } from '@playwright/test';
import { isTargetDocumentNavigation } from './navigation-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'evidence');
const browsers = { chromium, firefox, webkit };
const browserName = process.env.REPRO_BROWSER || 'webkit';
assert.ok(browsers[browserName], `Unsupported browser: ${browserName}`);
await fs.mkdir(output, { recursive: true });
const records = [];
const note = (kind, extra = {}) => records.push({ kind, at: Date.now(), ...extra });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function build() {
  const log = await fs.open(path.join(output, 'build.log'), 'w');
  try {
    const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], {
      cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', log.fd, log.fd],
    });
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(status, 0, 'Next.js production build failed; see evidence/build.log');
  } finally { await log.close(); }
}
async function startNext(port) {
  const log = await fs.open(path.join(output, 'next-start.log'), 'w');
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', log.fd, log.fd],
  });
  let ready = false;
  try {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) break;
      try { ready = (await fetch(`http://127.0.0.1:${port}/a`)).ok; } catch { /* warming */ }
      if (ready) break;
      await sleep(100);
    }
    assert.ok(ready, 'Next server not ready; see evidence/next-start.log');
  } catch (err) { child.kill('SIGTERM'); await log.close(); throw err; }
  return { child, log };
}
async function startProxy(nextPort, state) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const isDocument = isTargetDocumentNavigation({ method: req.method, pathname,
      rsc: req.headers.rsc, dest: req.headers['sec-fetch-dest'], accept: req.headers.accept });
    note('proxy-incoming', { path: req.url, document: isDocument, rsc: req.headers.rsc ?? null });
    if (state.return204Once && isDocument) {
      state.return204Once = false;
      note('proxy-html-204', { path: req.url });
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: nextPort, method: req.method, path: req.url,
      headers: req.headers, // Keep the proxy origin as Host, so generated URLs stay on one origin.
    }, response => {
      note('proxy-upstream-response', { path: req.url, status: response.statusCode, document: isDocument });
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', error => {
      note('proxy-error', { error: String(error) });
      if (!res.headersSent) res.writeHead(502);
      res.end('Local proxy error');
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, server };
}
async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}
async function caseRun(browser, proxyUrl, name, state) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__reproDocumentId = `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  });
  const page = await context.newPage();
  const out = { name, status: 'inconclusive', initialDocument: null, survived: null,
    attemptedHardNavigation: false, secondClickReachedB: false, retryHtmlRequests: 0,
    retryRscRequests: 0, browserErrors: [], dialogs: 0 };
  let indexOfRetry = 0;
  const events = [];
  const add = (kind, fields = {}) => events.push({ kind, at: Date.now(), ...fields });
  page.on('pageerror', e => { out.browserErrors.push(String(e)); add('pageerror', { error: String(e) }); });
  page.on('request', req => add('request', {
    url: req.url(), nav: req.isNavigationRequest(), rsc: req.headers().rsc ?? null,
  }));
  page.on('response', res => add('response', {
    url: res.url(), status: res.status(), nav: res.request().isNavigationRequest(),
  }));
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) add('framenavigated', { url: frame.url() });
  });
  page.on('dialog', async dialog => {
    out.dialogs += 1;
    add('dialog', { type: dialog.type() });
    try { await dialog.dismiss(); add('dialog-dismissed', { type: dialog.type() }); }
    catch (error) { out.browserErrors.push(String(error)); }
  });
  try {
    await page.goto(`${proxyUrl}/a`);
    await page.locator('#to-b').waitFor();
    await page.waitForFunction(() => typeof window.__reproDocumentId === 'string');
    out.initialDocument = await page.evaluate(() => window.__reproDocumentId);
    const start = Date.now();
    if (name === 'beforeunload-dismissed') {
      await page.evaluate(() => {
        const handler = event => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', handler);
        window.__clearReproBeforeUnload = () => window.removeEventListener('beforeunload', handler);
      });
    }
    if (name === 'http204') state.return204Once = true;
    try { await page.locator('#to-b').click({ noWaitAfter: true, timeout: 7000 }); }
    catch (err) { add('initial-click-error', { error: String(err) }); }
    const cancellation = await waitFor(() =>
      name === 'http204'
        ? records.some(e => e.kind === 'proxy-html-204' && e.at >= start)
        : events.some(e => e.kind === 'dialog-dismissed' && e.type === 'beforeunload' && e.at >= start)
    );
    out.attemptedHardNavigation = cancellation;
    await sleep(500); // Diagnostic observation only; not an application recovery timer.
    const current = await page.evaluate(() => window.__reproDocumentId).catch(() => null);
    out.survived = current === out.initialDocument && page.url().endsWith('/a');
    if (name === 'normal-navigation') {
      // No deliberate cancellation in this control. Check that MPA actually reaches /b.
      out.secondClickReachedB = page.url().endsWith('/b');
      out.status = out.secondClickReachedB && current !== out.initialDocument ? 'normal-hard-navigation-ok' : 'normal-hard-navigation-failed';
    } else if (!cancellation || !out.survived) {
      out.status = 'inconclusive-no-confirmed-cancellation';
    } else {
      state.return204Once = false;
      if (name === 'beforeunload-dismissed')
        await page.evaluate(() => window.__clearReproBeforeUnload?.()).catch(() => {});
      indexOfRetry = events.length;
      try { await page.locator('#to-b').click({ noWaitAfter: true, timeout: 5000 }); }
      catch (err) { add('retry-click-error', { error: String(err) }); }
      await waitFor(() => page.url().endsWith('/b'), 2500);
      const retry = events.slice(indexOfRetry);
      out.retryHtmlRequests = retry.filter(e => e.kind === 'request' && e.nav && e.url.endsWith('/b')).length;
      out.retryRscRequests = retry.filter(e => e.kind === 'request' && e.rsc === '1' && e.url.includes('/b')).length;
      out.secondClickReachedB = page.url().endsWith('/b');
      out.status = out.secondClickReachedB ? 'retry-succeeded' : 'retry-stuck';
    }
  } catch (error) {
    out.status = 'test-error'; out.browserErrors.push(String(error));
  } finally {
    await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify({ ...out, events }, null, 2));
    await context.close();
  }
  console.log(`REPRO ${name}: ${JSON.stringify({
    status: out.status, canceled: out.attemptedHardNavigation,
    survived: out.survived, retryHtmlRequests: out.retryHtmlRequests,
    retryRscRequests: out.retryRscRequests, browserErrors: out.browserErrors.length,
  })}`);
  return out;
}

await build();
const nextPort = await freePort();
const next = await startNext(nextPort);
const state = { return204Once: false };
const proxy = await startProxy(nextPort, state);
let browser;
try {
  browser = await browsers[browserName].launch({ headless: true });
  const results = [];
  for (const name of ['normal-navigation', 'http204', 'beforeunload-dismissed']) {
    results.push(await caseRun(browser, proxy.url, name, state));
  }
  const summary = { next: '16.4.5', playwright: '1.61.1', browser: browserName,
    url: proxy.url, results, proxyEvents: records };
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  assert.equal(results[0].status, 'normal-hard-navigation-ok', 'Positive MPA control failed');
  assert.ok(results.slice(1).every(c => c.attemptedHardNavigation && c.survived),
    'Cancellation not proven in both cases; keep inconclusive');
  console.log('REPRO SUMMARY: ' + JSON.stringify(results.map(c => ({ name: c.name, status: c.status }))));
} finally {
  await browser?.close();
  await new Promise(resolve => proxy.server.close(resolve));
  next.child.kill('SIGTERM');
  if (next.child.exitCode === null) await new Promise(resolve => next.child.once('exit', resolve));
  await next.log.close();
}
