import { test, expect, describe, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { AgyCliAdvisorProvider, parseAgyModelsOutput } from '../../src/advisor/agy-cli';
import { DesignAdvisorService, DeterministicAdvisorProvider } from '../../src/chatbot/advisor';
import type { DesignQueryContext } from '../../src/chatbot/types';
import type { Checkpoint } from '../../src/bridge/timeline';

// The provider spawns the agy binary directly; the shim execs node with the double script
// so tests exercise the real subprocess contract end to end.
const doublePath = path.join(__dirname, '..', 'fixtures', 'agy-double.mjs');

async function makeAgyShim(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scrubline-agy-shim-'));
  const base = path.join(dir, 'agy');
  if (process.platform === 'win32') {
    // Windows command shims run through cmd.exe; the provider resolves the
    // extension-less path to agy.cmd, so return the base path.
    await fs.promises.writeFile(
      `${base}.cmd`,
      `@echo off\r\n"${process.execPath}" "${doublePath}" %*\r\n`
    );
    return base;
  }
  await fs.promises.writeFile(
    base,
    `#!/bin/sh\nAGY_DOUBLE_BEHAVIOR="$AGY_DOUBLE_BEHAVIOR" exec "${process.execPath}" "${doublePath}" "$@"\n`,
    { mode: 0o755 }
  );
  return base;
}

function context(): DesignQueryContext {
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    id: 'b'.repeat(64),
    parentId: null,
    createdAt: new Date().toISOString(),
    trigger: 'baseline',
    files: [],
    attribution: { kind: 'unattributed' }
  };
  return {
    activeCheckpoint: checkpoint,
    targetFiles: [
      {
        path: 'index.html',
        content: '<nav>Home</nav><main>Hero</main>',
        isHtml: true,
        isCss: false
      }
    ],
    cssDeclarations: [],
    htmlElements: [{ tag: 'nav', classes: [] }],
    visual: {
      hasScreenshot: false,
      hasRegions: false,
      regionCount: 0,
      hasReceipt: false,
      limitations: []
    },
    userQuery: 'Is the nav spacing off?'
  };
}

test('agy provider maps structured output into a full advice response', async () => {
  const shim = await makeAgyShim();
  const provider = new AgyCliAdvisorProvider({ agyPath: shim, timeoutMs: 15000 });
  const advice = await provider.generateAdvice(context());
  expect(advice.directAnswer).toContain('nav gap');
  expect(advice.findings[0].title).toBe('Nav gap drift');
  expect(advice.findings[0].evidence).toEqual([]);
  expect(advice.recommendations[0].id).toMatch(/^agy-rec-/);
  expect(advice.checkpointId).toBe('b'.repeat(64));
  expect(advice.disclaimers[0]).toContain('Antigravity model');
});

test('service falls back to heuristics when agy is not signed in, absent, garbled, empty or slow', async () => {
  const shim = await makeAgyShim();
  const run = async (behavior: string, timeoutMs = 15000) => {
    process.env.AGY_DOUBLE_BEHAVIOR = behavior;
    const service = new DesignAdvisorService(
      new AgyCliAdvisorProvider({ agyPath: shim, timeoutMs }),
      new DeterministicAdvisorProvider()
    );
    const advice = await service.ask(context());
    expect(service.getLastUsedProviderName()).toBe('deterministic-heuristics');
    expect(advice.disclaimers[0]).toContain('Model backend unavailable');
    return advice;
  };
  await run('auth');
  await run('garbage');
  await run('empty');
  await run('slow', 300);
  process.env.AGY_DOUBLE_BEHAVIOR = 'success';
  const missing = new DesignAdvisorService(
    new AgyCliAdvisorProvider({ agyPath: '/nonexistent/agy-binary', timeoutMs: 5000 }),
    new DeterministicAdvisorProvider()
  );
  const advice = await missing.ask(context());
  expect(missing.getLastUsedProviderName()).toBe('deterministic-heuristics');
  expect(advice.disclaimers[0]).toContain('Model backend unavailable');
  delete process.env.AGY_DOUBLE_BEHAVIOR;
});

test('strict agy mode surfaces the backend error instead of falling back', async () => {
  const shim = await makeAgyShim();
  process.env.AGY_DOUBLE_BEHAVIOR = 'auth';
  const service = new DesignAdvisorService(
    new AgyCliAdvisorProvider({ agyPath: shim, timeoutMs: 15000 })
  );
  await expect(service.ask(context())).rejects.toThrow(/not signed in/);
  delete process.env.AGY_DOUBLE_BEHAVIOR;
});

describe('parseAgyModelsOutput', () => {
  it('parses the real agy 1.2.16 models table (slugs + display names with parentheses)', () => {
    const sample = [
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low      Gemini 3.8 Flash (Low)',
      'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)',
      'claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium       GPT-OSS 120B (Medium)'
    ].join('\n');
    expect(parseAgyModelsOutput(sample)).toEqual([
      { slug: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { slug: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
      { slug: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { slug: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      { slug: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
    ]);
  });

  it('parses CRLF output from Windows pipes', () => {
    const sample =
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\r\n' +
      'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)\r\n';
    expect(parseAgyModelsOutput(sample)).toEqual([
      { slug: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }
    ]);
  });

  it('strips ANSI styling some Windows CLIs emit when piped', () => {
    const sample =
      '\u001b[32mgemini-3.8-flash-high\u001b[0m     \u001b[1mGemini 3.8 Flash (High)\u001b[0m\n' +
      '\u001b[32mclaude-sonnet-4-6\u001b[0m         Claude Sonnet 4.6 (Thinking)\n';
    expect(parseAgyModelsOutput(sample)).toEqual([
      { slug: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }
    ]);
  });

  it('parses tab-separated non-TTY output', () => {
    const sample =
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' +
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
    expect(parseAgyModelsOutput(sample)).toEqual([
      { slug: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }
    ]);
  });

  it('skips headers, blanks and single-space prose lines', () => {
    const sample = [
      'Available models:',
      '',
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)',
      'single space is not a table row',
      'tip: run agy models --json for scripting'
    ].join('\n');
    expect(parseAgyModelsOutput(sample)).toEqual([
      { slug: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }
    ]);
  });
});
