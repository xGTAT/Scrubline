import { describe, it, expect } from 'vitest';
import { redactPath, redactUrl, globToRegExp, createCapture } from '../../src/backend/capture';
import { scanEndpoints, matchRoute } from '../../src/backend/endpoints';
import { buildImportGraph } from '../../src/backend/graph';
import { diffCaptures } from '../../src/backend/diff';
import type { BackendCapture } from '../../src/backend/types';

describe('redactPath', () => {
  it('replaces JWT, long hex, uuid and opaque segments', () => {
    expect(redactPath('/api/users/42')).toBe('/api/users/42');
    expect(
      redactPath(
        '/api/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      )
    ).toBe('/api/{redacted}');
    expect(redactPath('/sess/4f8b2c1d9e0a3b5c6d7e8f90')).toBe('/sess/{redacted}');
    expect(redactPath('/u/550e8400-e29b-41d4-a716-446655440000')).toBe('/u/{redacted}');
    expect(redactPath('/files/report')).toBe('/files/report');
  });
});

describe('redactUrl', () => {
  it('keeps host and path, drops query values and fragment', () => {
    const r = redactUrl('http://localhost:4100/api/items?token=sekret&id=3#frag');
    expect(r).toEqual({ host: 'localhost:4100', path: '/api/items', queryKeys: ['id', 'token'] });
  });
  it('rejects non-http and invalid URLs', () => {
    expect(redactUrl('data:text/html,x')).toBeNull();
    expect(redactUrl('ws://localhost/socket')).toBeNull();
    expect(redactUrl('not a url')).toBeNull();
  });
});

describe('globToRegExp', () => {
  it('matches ** across slashes and * within a segment', () => {
    expect(globToRegExp('**/api/**').test('http://x.test/api/users')).toBe(true);
    expect(globToRegExp('**/api/*').test('http://x.test/api/a/b')).toBe(false);
    expect(globToRegExp('http://*.example.com/**').test('http://cdn.example.com/a.js')).toBe(true);
  });
});

function fakeRequest(over: Partial<Record<string, unknown>> = {}) {
  const base = {
    url: () => 'http://localhost:4100/api/data?key=value',
    method: () => 'GET',
    resourceType: () => 'fetch',
    timing: () => ({ startTime: 1000, responseEnd: 1120 }),
    response: async () => ({ status: () => 200 }),
    failure: () => null
  };
  return { ...base, ...over };
}

function fakePage() {
  const handlers: Record<string, (req: unknown) => void> = {};
  return {
    on: (event: string, handler: (req: unknown) => void) => {
      handlers[event] = handler;
    },
    emit: (event: string, req: unknown) => handlers[event]?.(req)
  };
}

describe('createCapture', () => {
  it('records metadata only, flags mutations and redacts URLs', async () => {
    const page = fakePage();
    const c = createCapture({});
    c.attach(page as never);
    page.emit('requestfinished', fakeRequest());
    page.emit(
      'requestfinished',
      fakeRequest({
        url: () => 'http://localhost:4100/api/items?token=abc123',
        method: () => 'POST',
        timing: () => ({ startTime: 1150, responseEnd: 1300 })
      })
    );
    page.emit('requestfailed', fakeRequest({ failure: () => ({ errorText: 'net::ERR_ABORTED' }) }));
    await c.finish();
    const capture = c.build('c'.repeat(64), 'spec', 'http://localhost:4100/');
    expect(capture.entries).toHaveLength(3);
    const read = capture.entries.find((e) => e.method === 'GET' && !e.failure)!;
    const write = capture.entries.find((e) => e.method === 'POST')!;
    const failed = capture.entries.find((e) => e.failure)!;
    expect(read.queryKeys).toEqual(['key']);
    expect(read.durationMs).toBe(120);
    expect(read.mutation).toBe(false);
    expect(read.sameOrigin).toBe(true);
    expect(write.mutation).toBe(true);
    expect(failed.failure).toBe('aborted');
    expect(failed.status).toBeNull();
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('key=value');
  });
  it('applies the URL filter and truncates at the cap', async () => {
    const page = fakePage();
    const c = createCapture({ filter: '**/api/**', maxEntries: 2 });
    c.attach(page as never);
    page.emit('requestfinished', fakeRequest({ url: () => 'http://localhost:4100/style.css' }));
    page.emit('requestfinished', fakeRequest());
    page.emit('requestfinished', fakeRequest({ url: () => 'http://localhost:4100/api/two' }));
    page.emit('requestfinished', fakeRequest({ url: () => 'http://localhost:4100/api/three' }));
    await c.finish();
    const capture = c.build('c'.repeat(64), 'spec', 'http://localhost:4100/');
    expect(capture.entries).toHaveLength(2);
    expect(capture.truncated).toBe(true);
    expect(capture.entries.every((e) => e.path.startsWith('/api/'))).toBe(true);
  });
});

const SERVER = `
const express = require('express');
const app = express();
const router = express.Router();
app.get('/api/status', (req, res) => res.json({ ok: true }));
app.post('/api/items', createItem);
router.get('/:id', getItem);
app.use('/api/items', router);
app.get(prefixed('/dyn'), handler);
`;

describe('scanEndpoints', () => {
  it('finds literal app and mounted router routes', () => {
    const map = scanEndpoints([{ path: 'server.js', content: SERVER }]);
    expect(map.framework).toBe('express');
    const paths = map.routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /api/status');
    expect(paths).toContain('POST /api/items');
    expect(paths).toContain('GET /api/items/:id');
    expect(map.notes.some((n) => /dynamic|non-literal/i.test(n))).toBe(true);
  });
  it('reports unknown framework without express hints', () => {
    const map = scanEndpoints([{ path: 'main.ts', content: 'console.log(1)' }]);
    expect(map.framework).toBe('unknown');
    expect(map.routes).toHaveLength(0);
  });
});

describe('matchRoute', () => {
  const routes = scanEndpoints([{ path: 'server.js', content: SERVER }]).routes;
  it('matches exact, param and redacted segments', () => {
    expect(matchRoute('/api/status', routes)).toBeGreaterThanOrEqual(0);
    expect(matchRoute('/api/items/42', routes)).toBeGreaterThanOrEqual(0);
    expect(matchRoute('/api/items/{redacted}', routes)).toBeGreaterThanOrEqual(0);
    expect(matchRoute('/nope', routes)).toBe(-1);
  });
});

describe('buildImportGraph', () => {
  it('resolves relative imports and lists external packages', () => {
    const files = [
      {
        path: 'server.js',
        content: "const r = require('./routes/items'); import x from 'express';"
      },
      { path: 'routes/items.js', content: "import { db } from '../db';" },
      { path: 'db.js', content: 'export const db = 1;' }
    ];
    const graph = buildImportGraph(files);
    expect(graph.edges).toContainEqual({ from: 'server.js', to: 'routes/items.js' });
    expect(graph.edges).toContainEqual({ from: 'routes/items.js', to: 'db.js' });
    expect(graph.external).toContain('express');
    expect(graph.nodes).toHaveLength(3);
  });
});

describe('diffCaptures', () => {
  const base: BackendCapture = {
    version: 1,
    checkpoint: 'a'.repeat(64),
    specification: 's',
    capturedAt: 't',
    pageHost: 'h',
    truncated: false,
    coverage: [],
    entries: [
      {
        method: 'GET',
        host: 'h',
        path: '/a',
        queryKeys: [],
        status: 200,
        resourceType: 'fetch',
        startedAt: 0,
        durationMs: 100,
        sameOrigin: true,
        mutation: false
      },
      {
        method: 'GET',
        host: 'h',
        path: '/b',
        queryKeys: [],
        status: 200,
        resourceType: 'fetch',
        startedAt: 0,
        durationMs: 100,
        sameOrigin: true,
        mutation: false
      }
    ]
  };
  it('reports added, removed, status and timing changes', () => {
    const after: BackendCapture = {
      ...base,
      checkpoint: 'b'.repeat(64),
      entries: [
        { ...base.entries[0], status: 500 },
        { ...base.entries[1], durationMs: 400 },
        { ...base.entries[0], path: '/c' }
      ]
    };
    const diff = diffCaptures(base, after);
    expect(diff).toContainEqual({ key: 'GET h/a', kind: 'status', before: '200', after: '500' });
    expect(diff).toContainEqual({
      key: 'GET h/b',
      kind: 'timing',
      before: '100ms',
      after: '400ms'
    });
    expect(diff).toContainEqual({ key: 'GET h/c', kind: 'added', after: '200' });
    const removed = diffCaptures(after, base).find((d) => d.kind === 'removed');
    expect(removed?.key).toBe('GET h/c');
  });
});
