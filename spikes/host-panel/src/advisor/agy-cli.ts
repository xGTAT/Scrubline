import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Windows command shims (agy.cmd / agy.bat) cannot be spawned directly: cmd.exe
// must interpret them. Resolve a real executable when the given path has no
// extension, and let Node/libuv compose the cmd.exe command line (shell: true)
// instead of hand-quoting, which breaks on cmd's quote-stripping rules.
function spawnAgy(agyPath: string, args: string[], input = false) {
  const stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] = [input ? 'pipe' : 'ignore', 'pipe', 'pipe'];
  if (process.platform !== 'win32') return spawn(agyPath, args, { stdio });
  const lower = agyPath.toLowerCase();
  const needsCmd = lower.endsWith('.cmd') || lower.endsWith('.bat') || !/\.exe$/.test(lower);
  if (!needsCmd) return spawn(agyPath, args, { stdio });
  return spawn(agyPath, args, { shell: true, stdio });
}

async function resolveAgyExecutable(agyPath: string): Promise<string> {
  if (process.platform !== 'win32') return agyPath;
  if (/\.(exe|cmd|bat)$/i.test(agyPath)) return agyPath;
  // An explicit path wins over PATH lookup when the extension is omitted.
  if (agyPath.includes('/') || agyPath.includes('\\')) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      try {
        await fs.promises.access(agyPath + ext);
        return agyPath + ext;
      } catch {
        // try the next extension
      }
    }
  }
  return agyPath; // bare name: cmd.exe resolves it via PATH + PATHEXT
}

import type { DesignAdviceResponse, DesignQueryContext } from '../chatbot/types';
import type { DesignAdvisorProvider } from '../chatbot/advisor';

export interface AgyCliOptions {
  /** Path to the Antigravity CLI executable. Default: 'agy' (resolved via PATH). */
  agyPath?: string;
  /** Kill the CLI and fall back after this many milliseconds. Default: 90000. */
  timeoutMs?: number;
  /** Optional model override passed as --model. */
  model?: string;
  /** Diagnostic log sink (e.g. the extension output channel). */
  log?: (message: string) => void;
}

/**
 * JSON schema enforced through the CLI's --json-schema flag so the model answer
 * arrives as structured output. Evidence arrays, ids and timestamps are filled
 * by the provider, never invented by the model.
 */
const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    directAnswer: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['observation', 'issue', 'praise', 'limitation'] },
          category: {
            type: 'string',
            enum: [
              'spacing',
              'typography',
              'layout',
              'color_consistency',
              'accessibility',
              'visual_hierarchy',
              'diff_comparison',
              'general'
            ]
          },
          title: { type: 'string' },
          details: { type: 'string' }
        },
        required: ['type', 'category', 'title', 'details']
      }
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'spacing',
              'typography',
              'layout',
              'color_consistency',
              'accessibility',
              'visual_hierarchy',
              'diff_comparison',
              'general'
            ]
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          description: { type: 'string' },
          rationale: { type: 'string' },
          tradeOffs: { type: 'string' },
          suggestedCode: { type: 'string' },
          targetFile: { type: 'string' }
        },
        required: ['category', 'priority', 'title', 'description', 'rationale', 'tradeOffs']
      }
    },
    disclaimers: { type: 'array', items: { type: 'string' } },
    suggestedSnippets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          language: { type: 'string' },
          code: { type: 'string' },
          targetFile: { type: 'string' }
        },
        required: ['title', 'language', 'code']
      }
    }
  },
  required: ['summary', 'directAnswer', 'findings', 'recommendations']
};

const MAX_FILE_CHARS = 4000;
const MAX_TOTAL_CHARS = 24000;

export function buildPrompt(context: DesignQueryContext): string {
  const parts: string[] = [
    'You are the Scrubline UI Advisor inside a VS Code style IDE. Answer the design question using ONLY the checkpoint evidence below.',
    'Do not use any tools. Do not read or write files. Answer from this prompt alone.',
    'Rules: never invent evidence; every finding must cite the HTML/CSS provided here; if the evidence is insufficient, say so in disclaimers; keep the direct answer under 120 words.',
    '',
    `USER QUESTION: ${context.userQuery}`,
    '',
    `ACTIVE CHECKPOINT: ${context.activeCheckpoint.id} at ${context.activeCheckpoint.createdAt}`
  ];
  if (context.compareCheckpoint)
    parts.push(
      `COMPARE CHECKPOINT: ${context.compareCheckpoint.id} at ${context.compareCheckpoint.createdAt}`
    );
  if (context.lockedElements?.length) {
    parts.push('', 'LOCKED ELEMENTS (never suggest changing these; advise the user instead):');
    for (const l of context.lockedElements)
      parts.push(`- ${l.selector} in ${l.document}${l.label ? ` (${l.label})` : ''}`);
  }
  parts.push('', 'TARGET FILES:');
  let budget = MAX_TOTAL_CHARS;
  for (const f of context.targetFiles) {
    if (budget <= 0) break;
    const slice = f.content.slice(0, Math.min(MAX_FILE_CHARS, budget));
    budget -= slice.length;
    parts.push(`--- ${f.path} (${f.isHtml ? 'html' : f.isCss ? 'css' : 'other'}) ---`, slice);
  }
  if (context.cssChanges?.length) {
    parts.push('', 'CSS CHANGES BETWEEN CHECKPOINTS:');
    for (const c of context.cssChanges.slice(0, 40))
      parts.push(`- ${c.selector} { ${c.property}: ${JSON.stringify(c)} }`.slice(0, 200));
  }
  if (context.perfDelta?.length) {
    parts.push('', 'PERFORMANCE CHANGES BETWEEN CHECKPOINTS (static metrics):');
    for (const d of context.perfDelta)
      parts.push(`- ${d.label}: ${d.before} -> ${d.after} (${d.delta > 0 ? '+' : ''}${d.delta})`);
  }
  parts.push('', 'HTML ELEMENTS:');
  for (const el of context.htmlElements.slice(0, 80))
    parts.push(
      `- <${el.tag}>${el.id ? `#${el.id}` : ''}${el.classes.length ? ` .${el.classes.join(' .')}` : ''}${el.role ? ` role=${el.role}` : ''}${el.textSnippet ? ` "${el.textSnippet.slice(0, 60)}"` : ''}`
    );
  parts.push(
    '',
    `VISUAL EVIDENCE AVAILABLE: screenshot=${context.visual.hasScreenshot}, regions=${context.visual.regionCount}, receipt=${context.visual.hasReceipt}`,
    ...(context.visual.limitations.length
      ? [`LIMITATIONS: ${context.visual.limitations.join('; ')}`]
      : [])
  );
  return parts.join('\n');
}

interface AgyEnvelope {
  status?: string;
  response?: string;
  error?: string;
  structured_output?: Record<string, unknown>;
}

interface AgyModelAnswer {
  summary?: string;
  directAnswer?: string;
  findings?: DesignAdviceResponse['findings'];
  recommendations?: DesignAdviceResponse['recommendations'];
  disclaimers?: string[];
  suggestedSnippets?: DesignAdviceResponse['suggestedSnippets'];
}

async function runAgy(
  prompt: string,
  options: AgyCliOptions
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const agyPath = options.agyPath ?? 'agy';
  const resolvedPath = await resolveAgyExecutable(agyPath);
  // On Windows, shell:true spawns cmd.exe successfully even when the target
  // binary is missing, so the process 'error' event never fires and the
  // failure surfaces as an opaque exit code instead of "failed to start".
  // Pre-check explicit paths so the error is consistent across platforms.
  if (agyPath.includes('/') || agyPath.includes('\\')) {
    try {
      await fs.promises.access(resolvedPath);
    } catch {
      throw new Error(`agy CLI failed to start: ${resolvedPath} not found`);
    }
  }
  const timeoutMs = options.timeoutMs ?? 90000;
  // The prompt can reach tens of KB, which overflows the Windows command-line
  // limit (cmd.exe shims cap near 8 KB: "The command line is too long."). The
  // headless contract streams prompts over stdin (`--input-format
  // stream-json`, one {"event":"user","message":{"content":...}} line per turn)
  // and `--json-schema` accepts a .json file path, so argv only carries short
  // flags on every platform.
  const schemaPath = path.join(
    os.tmpdir(),
    `scrubline-advice-schema-${process.pid}-${Date.now()}.json`
  );
  await fs.promises.writeFile(schemaPath, JSON.stringify(ADVICE_SCHEMA));
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--json-schema',
    schemaPath
  ];
  if (options.model) args.push('--model', options.model);
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnAgy(resolvedPath, args, true);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(() => reject(new Error(`agy CLI timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      // Resolve as soon as the result event arrives in the stream. agy may
      // linger after producing the result (agentic tool cleanup, browser
      // teardown), and waiting for process exit would time out even though
      // the answer is already available.
      let buffer = '';
      child.stdout!.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as { event?: string; result?: unknown };
            if (event.event === 'result' && event.result) {
              child.kill('SIGKILL');
              settle(() => resolve({ stdout, stderr, code: 0 }));
              return;
            }
          } catch {
            // Not a JSON line; keep accumulating.
          }
        }
      });
      child.stderr!.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        settle(() => reject(new Error(`agy CLI failed to start: ${err.message}`)));
      });
      child.on('close', (code) => {
        settle(() => resolve({ stdout, stderr, code }));
      });
      // The CLI may exit before reading the prompt (auth failure); never let an
      // early EPIPE crash the write.
      child.stdin!.on('error', () => {});
      child.stdin!.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      child.stdin!.end();
    });
  } finally {
    await fs.promises.unlink(schemaPath).catch(() => {});
  }
}

export interface AgyModel {
  slug: string;
  name: string;
}

// Some CLIs still emit ANSI styling when piped on Windows, where the console
// host enables virtual terminal processing, so strip escape sequences before
// parsing instead of trusting isTTY behavior.
/* eslint-disable no-control-regex -- matching ANSI escape sequences requires control chars */
const ANSI_PATTERN =
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
/* eslint-enable no-control-regex */

/**
 * Parses `agy models` output lines: "slug<2+ spaces>Display Name".
 * Tolerates CRLF endings, ANSI styling, padded columns (2+ spaces) and the
 * tab-separated form non-TTY output can take. A single plain space is not a
 * separator, so prose lines (headers, hints) never parse as models.
 */
export function parseAgyModelsOutput(stdout: string): AgyModel[] {
  const models: AgyModel[] = [];
  for (const rawLine of stdout.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
    const m = rawLine.trim().match(/^[-*\u2022]?\s*(\S+)(?:[ ]{2,}|\t)(.+)$/);
    if (m) models.push({ slug: m[1], name: m[2].trim() });
  }
  return models;
}

/**
 * Lists the models available to the signed-in account via `agy models`
 * (verified against the Antigravity CLI docs). Parses "slug  Display Name"
 * lines; skips blank lines and headers.
 */
export async function listAgyModels(options: AgyCliOptions = {}): Promise<AgyModel[]> {
  const agyPath = options.agyPath ?? 'agy';
  const resolvedPath = await resolveAgyExecutable(agyPath);
  const timeoutMs = 30000;
  const log = options.log ?? (() => {});
  log(`[agy models] spawn ${JSON.stringify(resolvedPath)} models (platform=${process.platform})`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnAgy(resolvedPath, ['models']);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('agy models timed out'));
    }, timeoutMs);
    child.stdout!.on('data', (d) => (stdout += d.toString()));
    child.stderr!.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`agy CLI failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      log(`[agy models] exit code=${code} stdout=${stdout.length}B stderr=${stderr.length}B`);
      if (stdout) log(`[agy models] stdout head: ${JSON.stringify(stdout.slice(0, 400))}`);
      if (stderr) log(`[agy models] stderr head: ${JSON.stringify(stderr.slice(0, 400))}`);
      if (code !== 0) {
        reject(new Error(`agy models exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      let models = parseAgyModelsOutput(stdout);
      if (!models.length && stderr.trim()) {
        // Some CLIs print their table on stderr when stdout is not a TTY.
        models = parseAgyModelsOutput(stderr);
        if (models.length) log(`[agy models] parsed ${models.length} model(s) from stderr`);
      }
      if (!models.length && (stdout.trim() || stderr.trim()))
        log('[agy models] output was non-empty but no model lines parsed (see heads above)');
      resolve(models);
    });
  });
}

/**
 * Answers design questions through the Antigravity CLI headless mode
 * (`agy -p ... --output-format json --json-schema ...`), which runs on the
 * user's own Antigravity credentials and quota. Throws on any failure so the
 * advisor service can fall back to the deterministic provider.
 */
export class AgyCliAdvisorProvider implements DesignAdvisorProvider {
  readonly name = 'agy-cli';

  constructor(private readonly options: AgyCliOptions = {}) {}

  async generateAdvice(context: DesignQueryContext): Promise<DesignAdviceResponse> {
    const prompt = buildPrompt(context);
    const { stdout, stderr, code } = await runAgy(prompt, this.options);
    if (/authentication required/i.test(stderr))
      throw new Error(
        'Antigravity CLI is not signed in. Run `agy` once interactively, then retry.'
      );
    if (code !== 0)
      throw new Error(
        `agy CLI exited with code ${code}: ${stderr.trim().slice(0, 300) || 'no diagnostics'}`
      );
    let envelope: AgyEnvelope | undefined;
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as { event?: string; result?: AgyEnvelope };
        if (event.event === 'result' && event.result) envelope = event.result;
      } catch {
        // step_update lines are informational; non-JSON lines are ignored here
        // and reported below when no result event ever arrives.
      }
    }
    if (!envelope)
      throw new Error(
        `agy CLI returned no result event: ${stdout.trim().slice(0, 200) || 'empty output'}`
      );
    if (envelope.status !== 'SUCCESS')
      throw new Error(`agy CLI run failed: ${envelope.error ?? envelope.status ?? 'unknown'}`);
    let answer: AgyModelAnswer | undefined = envelope.structured_output as
      AgyModelAnswer | undefined;
    if (!answer && envelope.response) {
      try {
        answer = JSON.parse(envelope.response) as AgyModelAnswer;
      } catch {
        answer = { summary: '', directAnswer: envelope.response.trim() };
      }
    }
    if (!answer?.directAnswer && !answer?.summary)
      throw new Error('agy CLI returned an empty answer.');
    return {
      id: `agy-${Date.now()}`,
      timestamp: new Date().toISOString(),
      query: context.userQuery,
      checkpointId: context.activeCheckpoint.id,
      compareCheckpointId: context.compareCheckpoint?.id,
      summary: answer.summary ?? answer.directAnswer ?? '',
      directAnswer: answer.directAnswer ?? answer.summary ?? '',
      findings: (answer.findings ?? []).map((f) => ({ ...f, evidence: [] })),
      recommendations: (answer.recommendations ?? []).map((r, i) => ({
        ...r,
        id: `agy-rec-${i}`,
        evidence: []
      })),
      visualEvidence: context.visual,
      disclaimers: [
        'Answered by an Antigravity model via the agy CLI; verify suggestions before applying.',
        ...(answer.disclaimers ?? [])
      ],
      suggestedSnippets: answer.suggestedSnippets ?? []
    };
  }
}
