import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { hashBytes } from '../store/store';
import type { PreviewConfig } from './runner';
export function specification(config: PreviewConfig) {
  const width = config.width ?? 960;
  const height = config.height ?? 600;
  if (![width, height].every((n) => Number.isInteger(n) && n >= 240 && n <= 3840))
    throw new Error('Preview dimensions must be integers from 240 to 3840.');
  const route = config.route ?? '/';
  const base = 'http://127.0.0.1';
  const resolved = new URL(route, base);
  if (
    route.includes('\\') ||
    !route.startsWith('/') ||
    route.startsWith('//') ||
    resolved.origin !== base ||
    resolved.hash
  )
    throw new Error('Preview route must be a local path without a fragment.');
  const readySelector = config.readySelector?.trim() ?? '';
  if (readySelector.length > 1000) throw new Error('Readiness selector too long.');
  return { width, height, route: resolved.pathname + resolved.search, readySelector };
}
export function specificationKey(config: PreviewConfig) {
  const spec = specification(config);
  return hashBytes(
    JSON.stringify({
      version: 5,
      guard: config.guard ?? null,
      ...spec,
      command: config.command,
      browser: config.browserIdentity ?? config.browserPath ?? '',
      engine: 'playwright-1.63.0',
      runtime: process.version,
      platform: process.platform,
      timeout: config.timeoutMs
    })
  );
}
const identities = new Map<string, { fingerprint: string; identity: string }>();
export async function identifyBrowser(config: PreviewConfig) {
  specification(config);
  if (!config.browserPath) return config;
  const info = await stat(config.browserPath);
  const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  const cached = identities.get(config.browserPath);
  if (cached?.fingerprint === fingerprint) return { ...config, browserIdentity: cached.identity };
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(config.browserPath)) digest.update(chunk);
  const identity = digest.digest('hex');
  identities.set(config.browserPath, { fingerprint, identity });
  return { ...config, browserIdentity: identity };
}
