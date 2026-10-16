import type { EndpointMap, EndpointRoute } from './types';

const ROUTER_DECL =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*\)\s*=>\s*)?express\.Router\s*\(/;
const ROUTE_CALL =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`]+)\3/g;
const MOUNT_CALL =
  /\b([A-Za-z_$][\w$]*)\.use\s*\(\s*(['"])([^'"]+)\2\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
const PLAIN_MOUNT = /\b([A-Za-z_$][\w$]*)\.use\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
const EXPRESS_HINT = /\bexpress\b|@nestjs|fastify|koa|hapi/;

/**
 * Literal-route scan for Express-style servers. Deliberately shallow: only
 * string-literal routes and one level of `use('/prefix', router)` mounting are
 * resolved. Anything dynamic is reported as a coverage note, never guessed.
 */
export function scanEndpoints(files: { path: string; content: string }[]): EndpointMap {
  const routes: EndpointRoute[] = [];
  const notes: string[] = [];
  let scanned = 0;
  let sawExpress = false;
  let sawDynamic = false;
  interface Pending {
    receiver: string;
    method: string;
    path: string;
    file: string;
    line: number;
  }
  const pending: Pending[] = [];
  const mounts: { prefix: string; router: string }[] = [];
  const routerVars = new Set<string>();
  for (const file of files) {
    const lines = file.content.split('\n');
    let fileHit = false;
    lines.forEach((text, index) => {
      if (EXPRESS_HINT.test(text)) sawExpress = true;
      const decl = text.match(ROUTER_DECL);
      if (decl) routerVars.add(decl[1]);
      for (const match of text.matchAll(ROUTE_CALL)) {
        fileHit = true;
        pending.push({
          receiver: match[1],
          method: match[2].toUpperCase(),
          path: match[4],
          file: file.path,
          line: index + 1
        });
      }
      for (const match of text.matchAll(MOUNT_CALL)) {
        fileHit = true;
        mounts.push({ prefix: match[3], router: match[4] });
      }
      for (const match of text.matchAll(PLAIN_MOUNT)) {
        if (routerVars.has(match[2])) mounts.push({ prefix: '', router: match[2] });
      }
      if (/\.(get|post|put|patch|delete|all|use)\s*\(\s*[^'"`\s)]/.test(text) && !/^\s*\/\//.test(text))
        sawDynamic = true;
    });
    if (fileHit || EXPRESS_HINT.test(file.content)) scanned++;
  }
  for (const route of pending) {
    if (route.receiver === 'app' || route.receiver === 'server') {
      routes.push({ method: route.method, path: route.path, file: route.file, line: route.line });
      continue;
    }
    if (routerVars.has(route.receiver)) {
      const mount = mounts.find((m) => m.router === route.receiver);
      const prefix = mount?.prefix ?? '';
      routes.push({
        method: route.method,
        path: `${prefix}${route.path}`.replace(/\/{2,}/g, '/') || '/',
        file: route.file,
        line: route.line
      });
      if (!mount)
        notes.push(`Router '${route.receiver}' mount point not found; shown without a prefix.`);
      continue;
    }
    notes.push(
      `Route on '${route.receiver}' in ${route.file}:${route.line} skipped; receiver is not a detected app or Router.`
    );
  }
  if (sawDynamic)
    notes.push('Dynamically registered or non-literal routes exist and are not listed.');
  if (sawExpress && routes.length === 0)
    notes.push('Express usage detected but no literal routes were found.');
  routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
  return {
    framework: sawExpress ? 'express' : 'unknown',
    routes,
    scannedFiles: scanned,
    notes: [...new Set(notes)]
  };
}

/** Match an observed request path to a detected route; ':' segments and
 * {redacted} segments each match any single segment. */
export function matchRoute(path: string, routes: EndpointRoute[]): number {
  const segments = path.split('/').filter(Boolean);
  let best = -1;
  let bestScore = -1;
  routes.forEach((route, index) => {
    const want = route.path.split('/').filter(Boolean);
    if (want.length !== segments.length) return;
    let score = 0;
    for (let i = 0; i < want.length; i++) {
      if (want[i] === segments[i]) score += 2;
      else if (want[i].startsWith(':') || segments[i] === '{redacted}') score += 1;
      else return;
    }
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}
