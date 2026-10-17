import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryStore } from '../../src/store/store';
import { DesignAdvisorService } from '../../src/chatbot/advisor';
import { assembleChatbotContext } from '../../src/chatbot/context';
import { ChatbotController } from '../../src/chatbot/controller';

const stubAdvisorService = () =>
  new DesignAdvisorService({
    name: 'test-stub',
    async generateAdvice(context) {
      return {
        id: 'stub-1',
        timestamp: new Date().toISOString(),
        query: context.userQuery,
        checkpointId: context.activeCheckpoint.id,
        summary: 'stub summary',
        directAnswer: 'stub answer',
        findings: [],
        recommendations: [],
        visualEvidence: context.visual,
        disclaimers: [],
        suggestedSnippets: []
      };
    }
  });

test('assembleChatbotContext reads files and redacts secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-test-store-'));
  try {
    const store = new HistoryStore(root);
    await store.acquireWriter();
    await store.open();

    const htmlContent =
      '<html><body><h1>Dashboard</h1><nav class="sidebar"><a href="#">Home</a></nav></body></html>';
    const cssContent = '.sidebar { display: flex; flex-direction: column; color: #123456; }';

    const files = [
      { path: 'index.html', hash: '', size: Buffer.byteLength(htmlContent), mode: 0o644 },
      { path: 'style.css', hash: '', size: Buffer.byteLength(cssContent), mode: 0o644 }
    ];

    const contents = new Map<string, Buffer>();
    contents.set('index.html', Buffer.from(htmlContent));
    contents.set('style.css', Buffer.from(cssContent));

    files[0].hash = (await import('crypto')).createHash('sha256').update(htmlContent).digest('hex');
    files[1].hash = (await import('crypto')).createHash('sha256').update(cssContent).digest('hex');

    const cp = await store.commit(files, contents, 'baseline', { kind: 'unattributed' });

    const context = await assembleChatbotContext(store, cp, 'What would you improve?', {
      secrets: ['Dashboard']
    });

    expect(context.targetFiles.length).toBe(2);
    expect(context.cssDeclarations.some((d) => d.selector === '.sidebar')).toBe(true);
    expect(context.htmlElements.some((e) => e.tag === 'nav')).toBe(true);
    // Secret redaction test
    const htmlFile = context.targetFiles.find((f) => f.path === 'index.html')!;
    expect(htmlFile.content).not.toContain('Dashboard');
    expect(htmlFile.content).toContain('[redacted]');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ChatbotController manages query flow and message history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-test-ctrl-'));
  try {
    const store = new HistoryStore(root);
    await store.acquireWriter();
    await store.open();

    const html = '<html><body><h1>App</h1></body></html>';
    const hash = (await import('crypto')).createHash('sha256').update(html).digest('hex');
    const cp = await store.commit(
      [{ path: 'index.html', hash, size: Buffer.byteLength(html), mode: 0o644 }],
      new Map([['index.html', Buffer.from(html)]]),
      'baseline',
      { kind: 'unattributed' }
    );

    let publishedState: import('../../src/chatbot/types').ChatbotState | undefined;
    const controller = new ChatbotController(
      store,
      () => undefined,
      async () => [],
      (s) => {
        publishedState = s;
      },
      stubAdvisorService()
    );

    const advice = await controller.handleQuery('Which changes should I prioritize?', cp.id);
    expect(advice.directAnswer).toBeDefined();
    expect(publishedState?.messages.length).toBe(2);
    expect(publishedState?.messages[0].sender).toBe('user');
    expect(publishedState?.messages[1].sender).toBe('advisor');
    expect(publishedState?.busy).toBe(false);

    controller.clearHistory();
    expect(publishedState?.messages.length).toBe(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
