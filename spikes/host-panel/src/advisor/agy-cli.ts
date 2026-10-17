import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
// Windows command shims (agy.cmd / agy.bat) cannot be spawned directly: cmd.exe
// must interpret them. Resolve a real executable when the given path has no
// extension, and let Node/libuv compose the cmd.exe command line (shell: true)
// instead of hand-quoting, which breaks on cmd's quote-stripping rules.
function spawnAgy(agyPath: string, args: string[]) {
  if (process.platform !== 'win32')
    return spawn(agyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const lower = agyPath.toLowerCase();
  const needsCmd = lower.endsWith('.cmd') || lower.endsWith('.bat') || !/\.exe$/.test(lower);
  if (!needsCmd) return spawn(agyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return spawn(agyPath, args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const timeoutMs = options.timeoutMs ?? 90000;
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(ADVICE_SCHEMA)
  ];
  if (options.model) args.push('--model', options.model);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnAgy(resolvedPath, args);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agy CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`agy CLI failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export interface AgyModel {
  slug: string;
  name: string;
}

/** Parses `agy models` output lines: "slug<2+ spaces>Display Name". */
export function parseAgyModelsOutput(stdout: string): AgyModel[] {
  const models: AgyModel[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^[-*\u2022]?\s*(\S+)\s{2,}(.+)$/);
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
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`agy CLI failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`agy models exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      resolve(parseAgyModelsOutput(stdout));
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
    let envelope: AgyEnvelope;
    try {
      envelope = JSON.parse(stdout.trim()) as AgyEnvelope;
    } catch {
      throw new Error(`agy CLI returned unparseable output: ${stdout.trim().slice(0, 200)}`);
    }
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
