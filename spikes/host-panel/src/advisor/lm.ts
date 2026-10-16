import type { DesignAdviceResponse, DesignQueryContext } from '../chatbot/types';
import type { DesignAdvisorProvider } from '../chatbot/advisor';
import { buildPrompt } from './agy-cli';

/**
 * Structural view of the IDE's `vscode.lm` language-model surface. Injected so
 * the provider stays testable outside an extension host; src/extension.ts wires
 * the real `vscode.lm` and `vscode.LanguageModelChatMessage`.
 */
export interface LmChatResponseLike {
  text: AsyncIterable<string>;
}

export interface LmChatModelLike {
  id: string;
  name?: string;
  vendor?: string;
  family?: string;
  sendRequest(
    messages: unknown[],
    options: unknown,
    token: unknown
  ): PromiseLike<LmChatResponseLike>;
}

export interface VsCodeLmLike {
  selectChatModels(selector?: {
    vendor?: string;
    family?: string;
    id?: string;
  }): PromiseLike<LmChatModelLike[]>;
}

export type LmUserMessageFactory = (text: string) => unknown;

export interface AntigravityLmOptions {
  /** Model id/name/family to prefer; first available model is used when unset. */
  model?: string;
  /** Abandon the request after this many milliseconds. Default: 90000. */
  timeoutMs?: number;
}

const JSON_OUTPUT_INSTRUCTION = [
  '',
  'OUTPUT FORMAT: respond with ONLY a JSON object (no prose, no code fences) of the shape:',
  '{"summary": string, "directAnswer": string, "findings": [{"type": "observation"|"issue"|"praise"|"limitation", "category": string, "title": string, "details": string}], "recommendations": [{"category": string, "priority": "high"|"medium"|"low", "title": string, "description": string, "rationale": string, "tradeOffs": string, "suggestedCode"?: string, "targetFile"?: string}], "disclaimers": [string], "suggestedSnippets": [{"title": string, "language": string, "code": string, "targetFile"?: string}]}'
].join('\n');

interface LmModelAnswer {
  summary?: string;
  directAnswer?: string;
  findings?: DesignAdviceResponse['findings'];
  recommendations?: DesignAdviceResponse['recommendations'];
  disclaimers?: string[];
  suggestedSnippets?: DesignAdviceResponse['suggestedSnippets'];
}

function extractJson(raw: string): LmModelAnswer | undefined {
  const attempts = [raw, raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1]);
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.trim()) as LmModelAnswer;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function pickModel(models: LmChatModelLike[], wanted?: string): LmChatModelLike {
  if (!wanted) return models[0];
  const needle = wanted.toLowerCase();
  const match = models.find((m) =>
    [m.id, m.name, m.family, m.vendor].some((v) => v?.toLowerCase() === needle)
  );
  return match ?? models[0];
}

/**
 * Answers design questions through the Antigravity IDE's own language models
 * via the `vscode.lm` extension API - no CLI, no subprocess. Requires the IDE
 * to be signed in; when it is not, `selectChatModels()` returns no models and
 * this provider throws so the advisor service can fall back.
 */
export class AntigravityLmAdvisorProvider implements DesignAdvisorProvider {
  readonly name = 'antigravity-ide-lm';

  constructor(
    private readonly lm: VsCodeLmLike,
    private readonly userMessage: LmUserMessageFactory,
    private readonly options: AntigravityLmOptions = {}
  ) {}

  private async availableModels(): Promise<LmChatModelLike[]> {
    let models: LmChatModelLike[];
    try {
      models = await this.lm.selectChatModels();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Antigravity IDE model lookup failed: ${reason}`);
    }
    if (!models.length)
      throw new Error(
        'Antigravity IDE exposes no language models to extensions. Sign in to Antigravity (Accounts menu), then retry.'
      );
    return models;
  }

  async generateAdvice(context: DesignQueryContext): Promise<DesignAdviceResponse> {
    const models = await this.availableModels();
    const model = pickModel(models, this.options.model);
    const prompt = buildPrompt(context) + JSON_OUTPUT_INSTRUCTION;
    const timeoutMs = this.options.timeoutMs ?? 90000;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    };
    const request = model.sendRequest([this.userMessage(prompt)], {}, token);
    const response = await Promise.race([
      request,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`IDE model request timed out after ${timeoutMs}ms.`)),
          timeoutMs
        )
      )
    ]);
    let raw = '';
    for await (const fragment of response.text) raw += fragment;
    if (!raw.trim()) throw new Error('Antigravity IDE model returned an empty answer.');
    const answer = extractJson(raw) ?? { directAnswer: raw.trim() };
    if (!answer.directAnswer && !answer.summary)
      throw new Error('Antigravity IDE model returned an empty answer.');
    return {
      id: `ide-lm-${Date.now()}`,
      timestamp: new Date().toISOString(),
      query: context.userQuery,
      checkpointId: context.activeCheckpoint.id,
      compareCheckpointId: context.compareCheckpoint?.id,
      summary: answer.summary ?? answer.directAnswer ?? '',
      directAnswer: answer.directAnswer ?? answer.summary ?? '',
      findings: (answer.findings ?? []).map((f) => ({ ...f, evidence: [] })),
      recommendations: (answer.recommendations ?? []).map((r, i) => ({
        ...r,
        id: `ide-lm-rec-${i}`,
        evidence: []
      })),
      visualEvidence: context.visual,
      disclaimers: [
        `Answered by the Antigravity IDE model "${model.name ?? model.id}" via the in-IDE language model API; verify suggestions before applying.`,
        ...(answer.disclaimers ?? [])
      ],
      suggestedSnippets: answer.suggestedSnippets ?? []
    };
  }
}

/**
 * Tries each provider in order, returning the first successful answer. Throws
 * the combined reasons when every provider fails, so the advisor service can
 * fall back to offline heuristics with full diagnostics.
 */
export class ChainedAdvisorProvider implements DesignAdvisorProvider {
  readonly name: string;

  constructor(private readonly providers: DesignAdvisorProvider[]) {
    this.name = providers.map((p) => p.name).join('>');
  }

  async generateAdvice(context: DesignQueryContext): Promise<DesignAdviceResponse> {
    const reasons: string[] = [];
    for (const provider of this.providers) {
      try {
        return await provider.generateAdvice(context);
      } catch (err) {
        reasons.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(reasons.join(' | ') || 'no providers configured');
  }
}
