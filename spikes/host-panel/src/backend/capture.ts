import type { BackendCapture, BackendRequestEntry } from './types';

const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LONG_HEX = /^[0-9a-f]{24,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9_-]{32,}$/;
const REDACTED = '{redacted}';

/** Replace segments that commonly carry tokens, session ids or signed blobs. */
export function redactPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) =>
      JWT.test(segment) || LONG_HEX.test(segment) || UUID.test(segment) || OPAQUE.test(segment)
        ? REDACTED
        : segment
    )
    .join('/');
}

/** Metadata-only URL: host, redacted path, query key names. Values never survive. */
export function redactUrl(raw: string): {
  host: string;
  path: string;
  queryKeys: string[];
} | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return {
    host: url.host,
    path: redactPath(url.pathname),
    queryKeys: [...new Set([...url.searchParams.keys()])].sort()
  };
}

/** Minimal glob: `**` crosses slashes, `*` stays within a segment. */
export function globToRegExp(glob: string): RegExp {
  const sentinel = '\u0000';
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, sentinel)
    .replace(/\*/g, '[^/]*')
    .split(sentinel)
    .join('.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i');
}

const MUTATION_SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const isAbort = (text: string) => /abort/i.test(text);

export interface CaptureCollector {
  attach(page: import('playwright-core').Page): void;
  finish(): Promise<void>;
  build(checkpoint: string, specification: string, pageUrl: string): BackendCapture;
}

/**
 * Records request metadata through Playwright events in memory. Nothing here
 * touches headers, cookies, post data, query values or response bodies; the
 * sanitized artifact is assembled in memory and written once by the caller.
 */
export function createCapture(options: { filter?: string; maxEntries?: number }): CaptureCollector {
  const max = Math.max(1, Math.min(options.maxEntries ?? 200, 1000));
  const matcher = options.filter?.trim() ? globToRegExp(options.filter.trim()) : null;
  const entries: BackendRequestEntry[] = [];
  const pending: Promise<void>[] = [];
  let truncated = false;
  let firstStart = Number.NaN;
  let done = false;
  const record = async (
    request: import('playwright-core').Request,
    failure?: string
  ): Promise<void> => {
    if (done) return;
    await Promise.resolve();
    const raw = request.url();
    if (matcher && !matcher.test(raw)) return;
    const parts = redactUrl(raw);
    if (!parts) return;
    const timing = request.timing();
    if (Number.isNaN(firstStart) && timing.startTime > 0) firstStart = timing.startTime;
    const response = await request.response().catch(() => null);
    // Chromium reports 204 No Content as ERR_ABORTED; if we got a response, the request succeeded.
    const effectiveFailure = response ? undefined : failure;
    if (entries.length >= max) {
      truncated = true;
      return;
    }
    const method = request.method().toUpperCase();
    entries.push({
      method,
      host: parts.host,
      path: parts.path,
      queryKeys: parts.queryKeys,
      status: response ? response.status() : null,
      resourceType: request.resourceType(),
      startedAt:
        timing.startTime > 0 && Number.isFinite(firstStart)
          ? Math.max(0, Math.round(timing.startTime - firstStart))
          : -1,
      durationMs:
        timing.responseEnd > 0 && timing.startTime > 0
          ? Math.max(0, Math.round(timing.responseEnd - timing.startTime))
          : null,
      sameOrigin: false,
      mutation: !MUTATION_SAFE.has(method),
      ...(effectiveFailure ? { failure: effectiveFailure } : {})
    });
  };
  return {
    attach(page) {
      const track = (job: Promise<void>) => {
        pending.push(job);
        void job.finally(() => {
          const index = pending.indexOf(job);
          if (index >= 0) pending.splice(index, 1);
        });
      };
      page.on('requestfinished', (request) => track(record(request)));
      page.on('requestfailed', (request) => {
        const text = request.failure()?.errorText ?? '';
        track(record(request, isAbort(text) ? 'aborted' : 'failed'));
      });
    },
    async finish() {
      done = true;
      while (pending.length) await Promise.all([...pending]);
    },
    build(checkpoint, specification, pageUrl) {
      const page = redactUrl(pageUrl);
      const pageHost = page?.host ?? '';
      for (const entry of entries) entry.sameOrigin = entry.host === pageHost;
      return {
        version: 1,
        checkpoint,
        specification,
        capturedAt: new Date().toISOString(),
        pageHost,
        entries,
        truncated,
        coverage: [
          'Browser-observed requests during this render only; not evidence of server-side or database behavior.',
          'Query values, headers, cookies and bodies are never recorded.',
          'WebSocket/SSE traffic and requests served entirely by a service worker are not captured.',
          'Requests fired after the screenshot (lazy or interaction-triggered) are absent.'
        ]
      };
    }
  };
}
