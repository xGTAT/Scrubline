import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const recorder = require('../../../../.agents/scripts/hook-recorder.js');
const RECORDER_PATH = resolve(__dirname, '../../../../.agents/scripts/hook-recorder.js');

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), 'scrubline-hooktest-'));
}

function runHook(event, payload, runDir) {
  const logFile = join(runDir, 'events.jsonl');
  const res = spawnSync(process.execPath, [RECORDER_PATH, event], {
    input: payload,
    env: { PATH: process.env.PATH, SCRUBLINE_HOOK_LOG: logFile },
    encoding: 'utf8'
  });
  const lines = (() => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  })();
  return { res, lines };
}

describe('hook recorder contract', () => {
  it('post-tool emits {} and logs only allowlisted fields', () => {
    const runDir = makeRunDir();
    const workspace = join(runDir, 'ws1');
    mkdirSync(workspace, { recursive: true });
    try {
      // Real Antigravity payload shape: tool name and args live under toolCall;
      // workspace roots arrive as workspacePaths on the payload itself.
      const payload = JSON.stringify({
        conversationId: 'conv-secret-123',
        stepIdx: 7,
        toolCall: {
          name: 'editFile',
          args: { TargetFile: join(workspace, 'src', 'app.ts'), secret: 'do-not-persist' }
        },
        workspacePaths: [workspace],
        artifactPaths: ['/abs/artifact'],
        transcriptPath: '/abs/transcript'
      });
      const { res, lines } = runHook('post-tool', payload, runDir);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('{}');
      expect(lines).toHaveLength(1);
      const row = lines[0];
      expect(row.event).toBe('post-tool');
      expect(row.tool).toBe('editFile');
      expect(row.stepIdx).toBe(7);
      expect(row.targetFile).toBe('src/app.ts');
      // conversation id is hashed, never raw
      expect(row.conversation).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(row)).not.toContain('conv-secret-123');
      // no secret payload fields
      const dumped = JSON.stringify(row);
      for (const banned of ['do-not-persist', 'artifact', 'transcript', workspace]) {
        expect(dumped).not.toContain(banned);
      }
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('stop emits allow decision and records termination fields', () => {
    const runDir = makeRunDir();
    try {
      const payload = JSON.stringify({
        conversationId: 'conv-9',
        terminationReason: 'user_requested_stop',
        fullyIdle: true,
        transcriptPath: '/abs/transcript'
      });
      const { res, lines } = runHook('stop', payload, runDir);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual({ decision: 'allow' });
      const row = lines[0];
      expect(row.event).toBe('stop');
      expect(row.terminationReason).toBe('user_requested_stop');
      expect(row.fullyIdle).toBe(true);
      expect(JSON.stringify(row)).not.toContain('/abs/transcript');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('targetFile outside all workspaces is dropped', () => {
    const runDir = makeRunDir();
    const workspace = join(runDir, 'ws1');
    mkdirSync(workspace, { recursive: true });
    try {
      const payload = JSON.stringify({
        conversationId: 'c',
        toolCall: { name: 'readFile', args: { TargetFile: join(runDir, 'other', 'x.txt') } },
        workspacePaths: [workspace]
      });
      const { res, lines } = runHook('post-tool', payload, runDir);
      expect(res.status).toBe(0);
      const row = lines[0];
      expect(row.targetFile).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('x.txt');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('malformed payload logs only a parse-error flag', () => {
    const runDir = makeRunDir();
    try {
      const { res, lines } = runHook('post-tool', 'this is not json {', runDir);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('{}');
      const row = lines[0];
      expect(row.payloadParseError).toBe(true);
      expect(JSON.stringify(row)).not.toContain('this is not json');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('defaults the log to the OS temp dir, not the repo', () => {
    const f = recorder.defaultLogFile();
    expect(f.startsWith(tmpdir())).toBe(true);
    expect(f.endsWith(join('scrubline', 'hook-events.jsonl'))).toBe(true);
    expect(f.includes('Scrubline' + '.agents')).toBe(false);
  });

  it('toWorkspaceRelative and hashId are pure and deterministic', () => {
    expect(recorder.hashId('abc')).toMatch(/^[0-9a-f]{12}$/);
    expect(recorder.hashId('abc')).toBe(recorder.hashId('abc'));
    const ws = join(tmpdir(), 'w');
    expect(recorder.toWorkspaceRelative(join(ws, 'a', 'b.txt'), [ws])).toBe('a/b.txt');
    expect(
      recorder.toWorkspaceRelative(join(tmpdir(), 'elsewhere', 'b.txt'), [ws])
    ).toBeUndefined();
    expect(recorder.outputFor('stop')).toEqual({ decision: 'allow' });
    expect(recorder.outputFor('post-tool')).toEqual({});
    expect(readdirSync).toBeTypeOf('function');
  });
});
