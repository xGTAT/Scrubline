#!/usr/bin/env node
'use strict';
/**
 * Scrubline Antigravity hook recorder.
 *
 * Records a SANITISED one-line JSON summary per hook event. The raw hook
 * payload (conversation IDs, workspace paths, tool arguments, transcripts)
 * is never persisted.
 *
 * Log location: SCRUBLINE_HOOK_LOG if set, else <os-tmpdir>/scrubline/hook-events.jsonl.
 * The log always lives outside the repository.
 *
 * Output contract (stdout):
 *   - post-tool (PostToolUse): {}
 *   - stop (Stop):             {"decision":"allow"}
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** Stable short hash for identifiers that must not be stored raw. */
function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/**
 * Make a tool target path workspace-relative. Returns undefined when the
 * target is missing or outside every mounted workspace, so absolute paths
 * from other drives/folders are never persisted.
 */
function toWorkspaceRelative(target, workspacePaths) {
  if (typeof target !== 'string' || target.length === 0) return undefined;
  if (!Array.isArray(workspacePaths)) return undefined;
  for (const ws of workspacePaths) {
    if (typeof ws !== 'string' || ws.length === 0) continue;
    try {
      const rel = path.relative(path.resolve(ws), path.resolve(target));
      if (rel === '') return path.basename(target);
      if (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join('/');
      }
    } catch {
      // ignore unresolvable entries
    }
  }
  return undefined;
}

/** Build the sanitised log record. Only allowlisted fields survive. */
function sanitize(eventType, payload) {
  const record = { timestamp: new Date().toISOString(), event: eventType };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    record.payloadParseError = true;
    return record;
  }
  if (typeof payload.conversationId === 'string') {
    record.conversation = hashId(payload.conversationId);
  }
  if (Number.isInteger(payload.stepIdx)) {
    record.stepIdx = payload.stepIdx;
  }
  if (payload.toolCall && typeof payload.toolCall.name === 'string') {
    record.tool = payload.toolCall.name;
  }
  const args = (payload.toolCall && payload.toolCall.args) || {};
  const rel = toWorkspaceRelative(args.TargetFile || args.AbsolutePath, payload.workspacePaths);
  if (rel) {
    record.targetFile = rel;
    // Exact disk-content evidence, never tool arguments or file contents.
    for (const ws of payload.workspacePaths || []) {
      try {
        const root = fs.realpathSync(ws);
        const absolute = fs.realpathSync(path.resolve(ws, rel));
        const local = path.relative(root, absolute);
        if (local.startsWith('..') || path.isAbsolute(local)) continue;
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) continue;
        record.workspace = crypto.createHash('sha256').update(root).digest('hex');
        record.contentHash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        break;
      } catch { /* No disk evidence means no attribution match. */ }
    }
  }
  if (typeof payload.terminationReason === 'string') {
    record.terminationReason = payload.terminationReason;
  }
  if (typeof payload.fullyIdle === 'boolean') {
    record.fullyIdle = payload.fullyIdle;
  }
  return record;
}

function defaultLogFile() {
  return process.env.SCRUBLINE_HOOK_LOG || path.join(os.tmpdir(), 'scrubline', 'hook-events.jsonl');
}

function appendLog(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function outputFor(eventType) {
  return eventType === 'stop' ? { decision: 'allow' } : {};
}

function main() {
  const eventType = process.argv[2] || 'unknown';
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    let payload = null;
    let parseFailed = false;
    try {
      payload = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      parseFailed = true;
    }
    const record = sanitize(eventType, payload === null ? undefined : payload);
    if (parseFailed) record.payloadParseError = true;
    try {
      appendLog(defaultLogFile(), record);
    } catch (err) {
      console.error('hook log write failed:', err && err.message ? err.message : err);
    }
    process.stdout.write(JSON.stringify(outputFor(eventType)));
  });
}

if (require.main === module) {
  main();
}

module.exports = { sanitize, toWorkspaceRelative, hashId, outputFor, defaultLogFile };
