import { test, expect } from 'vitest';
import {
  AntigravityLmAdvisorProvider,
  ChainedAdvisorProvider,
  type LmChatModelLike,
  type VsCodeLmLike
} from '../../src/advisor/lm';
import type { DesignAdvisorProvider } from '../../src/chatbot/advisor';
import type { DesignQueryContext } from '../../src/chatbot/types';
import type { Checkpoint } from '../../src/bridge/timeline';

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
      hasComputedStyles: false,
      limitations: []
    },
    preferences: { reduceNoise: false, detail: 'standard', riskTolerance: 'balanced' },
    userQuery: 'Is the nav spacing consistent?'
  } as DesignQueryContext;
}

function stubModel(answer: string, id = 'gemini-3-pro'): LmChatModelLike {
  return {
    id,
    name: `Antigravity ${id}`,
    vendor: 'antigravity',
    family: 'gemini',
    async sendRequest(messages: unknown[]) {
      expect(messages).toHaveLength(1);
      return {
        text: (async function* () {
          yield answer;
        })()
      };
    }
  };
}

const userMessage = (text: string) => ({ role: 'user', text });

test('unsigned IDE (no models) fails with a sign-in hint', async () => {
  const lm: VsCodeLmLike = { selectChatModels: async () => [] };
  const provider = new AntigravityLmAdvisorProvider(lm, userMessage);
  await expect(provider.generateAdvice(context())).rejects.toThrow(/Sign in to Antigravity/);
});

test('model lookup errors are surfaced, not swallowed', async () => {
  const lm: VsCodeLmLike = {
    selectChatModels: async () => {
      throw new Error('lm unavailable');
    }
  };
  const provider = new AntigravityLmAdvisorProvider(lm, userMessage);
  await expect(provider.generateAdvice(context())).rejects.toThrow(/model lookup failed/i);
});

test('structured JSON answer maps into a full advice response', async () => {
  const answer = JSON.stringify({
    summary: 'Nav spacing is inconsistent.',
    directAnswer: 'Links use mixed padding values.',
    findings: [
      { type: 'issue', category: 'spacing', title: 'Mixed padding', details: 'nav a varies' }
    ],
    recommendations: [
      {
        category: 'spacing',
        priority: 'high',
        title: 'Unify padding',
        description: 'Use one padding scale.',
        rationale: 'Consistency.',
        tradeOffs: 'None.'
      }
    ],
    disclaimers: ['No screenshot available.'],
    suggestedSnippets: [{ title: 'Pad', language: 'css', code: 'nav a { padding: 8px; }' }]
  });
  const lm: VsCodeLmLike = { selectChatModels: async () => [stubModel(answer)] };
  const provider = new AntigravityLmAdvisorProvider(lm, userMessage);
  const result = await provider.generateAdvice(context());
  expect(result.directAnswer).toBe('Links use mixed padding values.');
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0].evidence).toEqual([]);
  expect(result.recommendations[0].id).toMatch(/^ide-lm-rec-/);
  expect(result.disclaimers.join(' ')).toContain('Antigravity IDE model');
  expect(result.disclaimers.join(' ')).toContain('No screenshot available.');
});

test('code-fenced JSON is parsed', async () => {
  const fenced =
    '```json\n{"summary":"s","directAnswer":"d","findings":[],"recommendations":[]}\n```';
  const lm: VsCodeLmLike = { selectChatModels: async () => [stubModel(fenced)] };
  const provider = new AntigravityLmAdvisorProvider(lm, userMessage);
  const result = await provider.generateAdvice(context());
  expect(result.directAnswer).toBe('d');
});

test('plain prose answer becomes the direct answer', async () => {
  const lm: VsCodeLmLike = {
    selectChatModels: async () => [stubModel('The nav spacing is not consistent.')]
  };
  const provider = new AntigravityLmAdvisorProvider(lm, userMessage);
  const result = await provider.generateAdvice(context());
  expect(result.directAnswer).toBe('The nav spacing is not consistent.');
});

test('configured model preference wins over the first model', async () => {
  const first = stubModel('{"directAnswer":"from first","findings":[],"recommendations":[]}', 'm1');
  first.family = 'other';
  const second = stubModel(
    '{"directAnswer":"from second","findings":[],"recommendations":[]}',
    'm2'
  );
  second.family = 'gemini';
  const lm: VsCodeLmLike = { selectChatModels: async () => [first, second] };
  const provider = new AntigravityLmAdvisorProvider(lm, userMessage, { model: 'gemini' });
  const result = await provider.generateAdvice(context());
  expect(result.directAnswer).toBe('from second');
});

test('empty model answer throws so fallback can engage', async () => {
  const lm: VsCodeLmLike = { selectChatModels: async () => [stubModel('   ')] };
  const provider = new AntigravityLmAdvisorProvider(lm, userMessage);
  await expect(provider.generateAdvice(context())).rejects.toThrow(/empty answer/);
});

test('chained provider returns the first successful answer', async () => {
  const failing: DesignAdvisorProvider = {
    name: 'primary-down',
    generateAdvice: async () => {
      throw new Error('no models');
    }
  };
  const working: DesignAdvisorProvider = {
    name: 'secondary',
    generateAdvice: async () => ({ summary: 'ok' }) as never
  };
  const chain = new ChainedAdvisorProvider([failing, working]);
  expect(chain.name).toBe('primary-down>secondary');
  const result = await chain.generateAdvice(context());
  expect(result.summary).toBe('ok');
});

test('chained provider reports every reason when all fail', async () => {
  const a: DesignAdvisorProvider = {
    name: 'ide',
    generateAdvice: async () => {
      throw new Error('not signed in');
    }
  };
  const b: DesignAdvisorProvider = {
    name: 'cli',
    generateAdvice: async () => {
      throw new Error('agy missing');
    }
  };
  const chain = new ChainedAdvisorProvider([a, b]);
  await expect(chain.generateAdvice(context())).rejects.toThrow(
    /ide: not signed in \| cli: agy missing/
  );
});
