import { it, expect } from 'vitest';
import * as http from 'node:http';
import { chromium } from 'playwright-core';
import { createCapture } from '../../src/backend/capture';
import { redactUrl } from '../../src/backend/capture';

// Real Chromium + real local server: the capture pipeline end to end,
// against a fixture backend with JSON routes. No external service.
it('captures real render traffic with redaction, failures and mutations', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h1>fixture</h1><script>
        fetch('/api/status?session=supersecret&ok=1').then(() =>
          fetch('/api/items', { method: 'POST', body: '{}' })).then(() =>
          fetch('/api/missing')).then(() =>
          fetch('/sess/4f8b2c1d9e0a3b5c6d7e8f90')).finally(() => {
            document.title = 'done';
          });
      </script></body></html>`);
      return;
    }
    if (req.url?.startsWith('/api/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/api/items') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url?.startsWith('/sess/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: ['--disable-gpu']
  });
  try {
    const page = await browser.newPage();
    const collector = createCapture({});
    collector.attach(page);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.title === 'done', undefined, { timeout: 10000 });
    await collector.finish();
    const capture = collector.build('c'.repeat(64), 'spec', `http://127.0.0.1:${port}/`);
    const paths = capture.entries.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /api/status');
    expect(paths).toContain('POST /api/items');
    expect(paths).toContain('GET /api/missing');
    expect(paths).toContain('GET /sess/{redacted}');
    const status = capture.entries.find((e) => e.path === '/api/status')!;
    expect(status.status).toBe(200);
    expect(status.queryKeys).toEqual(['ok', 'session']);
    expect(status.sameOrigin).toBe(true);
    const write = capture.entries.find((e) => e.path === '/api/items')!;
    expect(write.mutation).toBe(true);
    expect(write.status).toBe(201);
    const missing = capture.entries.find((e) => e.path === '/api/missing')!;
    expect(missing.status).toBe(404);
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('4f8b2c1d9e0a3b5c6d7e8f90');
    // Timings are real: every finished entry has a non-negative duration.
    for (const entry of capture.entries) {
      expect(entry.durationMs === null || entry.durationMs >= 0).toBe(true);
    }
  } finally {
    await browser.close();
    server.close();
  }
}, 30000);

it('never leaks userinfo and always drops fragment and query values', () => {
  const r = redactUrl('http://user:password@example.com:8080/a/b?x=secret#frag');
  expect(r).toEqual({ host: 'example.com:8080', path: '/a/b', queryKeys: ['x'] });
  expect(JSON.stringify(r)).not.toContain('password');
  expect(JSON.stringify(r)).not.toContain('secret');
  expect(JSON.stringify(r)).not.toContain('frag');
});

it('artifact failure entries carry a class, never raw error text', async () => {
  const page = {
    handlers: {} as Record<string, (r: unknown) => void>,
    on(e: string, h: (r: unknown) => void) {
      this.handlers[e] = h;
    }
  };
  const c = createCapture({});
  c.attach(page as never);
  page.handlers['requestfailed']?.({
    url: () => 'http://h.test/api?token=raw-secret-in-error-url',
    method: () => 'GET',
    resourceType: () => 'fetch',
    timing: () => ({ startTime: 0, responseEnd: -1 }),
    response: async () => null,
    failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED http://h.test/internal?token=leak' })
  });
  await c.finish();
  const capture = c.build('c'.repeat(64), 's', 'http://h.test/');
  expect(capture.entries[0].failure).toBe('failed');
  expect(JSON.stringify(capture)).not.toContain('leak');
  expect(JSON.stringify(capture)).not.toContain('raw-secret-in-error-url');
});
