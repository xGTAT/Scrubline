import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryStore } from '../../src/store/store';
import { detectQueryIntent, DesignAnalyzer } from '../../src/chatbot/analyzer';
import { assembleChatbotContext } from '../../src/chatbot/context';
import { ChatbotController } from '../../src/chatbot/controller';
import type { Checkpoint } from '../../src/bridge/timeline';

test('query intent detection classifies common UI/UX questions', () => {
  const q1 = detectQueryIntent('Does this page look cluttered? What would you improve?');
  expect(q1.isClutterOrSpacing).toBe(true);

  const q2 = detectQueryIntent(
    'Which parts of this UI could have better spacing or visual hierarchy?'
  );
  expect(q2.isClutterOrSpacing).toBe(true);
  expect(q2.isHierarchyOrTypography).toBe(true);

  const q3 = detectQueryIntent('Would a sidebar or a top navigation bar work better here?');
  expect(q3.isNavigation).toBe(true);

  const q4 = detectQueryIntent('What changed in the layout between these two recorded versions?');
  expect(q4.isVersionDiff).toBe(true);

  const q5 = detectQueryIntent(
    'Does this component appear inconsistent with the rest of the interface?'
  );
  expect(q5.isConsistency).toBe(true);

  const q6 = detectQueryIntent(
    'Which changes should I prioritize for the greatest visual improvement?'
  );
  expect(q6.isPrioritization).toBe(true);
});

test('DesignAnalyzer flags spacing issues, negative margins, and unspaced flex containers', () => {
  const analyzer = new DesignAnalyzer();
  const dummyCheckpoint: Checkpoint = {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    parentId: null,
    createdAt: new Date().toISOString(),
    trigger: 'baseline',
    files: [],
    attribution: { kind: 'unattributed' }
  };

  const response = analyzer.analyze({
    activeCheckpoint: dummyCheckpoint,
    targetFiles: [
      {
        path: 'styles.css',
        content: '.card { margin-top: -15px; } .row { display: flex; }',
        isHtml: false,
        isCss: true
      }
    ],
    cssDeclarations: [
      { path: 'styles.css', selector: '.card', property: 'margin-top', value: '-15px' },
      { path: 'styles.css', selector: '.row', property: 'display', value: 'flex' }
    ],
    htmlElements: [],
    visual: {
      hasScreenshot: false,
      hasRegions: false,
      regionCount: 0,
      hasReceipt: false,
      limitations: ['No screenshot']
    },
    userQuery: 'Does this page look cluttered? What would you improve?'
  });

  expect(response.directAnswer).toContain('spacing');
  expect(response.recommendations.some((r) => r.id === 'rec-spacing-negative')).toBe(true);
  expect(response.recommendations.some((r) => r.id === 'rec-flex-gap')).toBe(true);

  const rec = response.recommendations.find((r) => r.id === 'rec-spacing-negative')!;
  expect(rec.rationale).toBeDefined();
  expect(rec.tradeOffs).toBeDefined();
  expect(rec.suggestedCode).toContain('margin-top: 0;');
});

test('DesignAnalyzer flags skipped heading ranks and indistinguishable font sizes', () => {
  const analyzer = new DesignAnalyzer();
  const dummyCheckpoint: Checkpoint = {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    parentId: null,
    createdAt: new Date().toISOString(),
    trigger: 'baseline',
    files: [],
    attribution: { kind: 'unattributed' }
  };

  const response = analyzer.analyze({
    activeCheckpoint: dummyCheckpoint,
    targetFiles: [],
    cssDeclarations: [
      { path: 'styles.css', selector: '.title', property: 'font-size', value: '15px' },
      { path: 'styles.css', selector: '.body', property: 'font-size', value: '16px' },
      { path: 'styles.css', selector: '.caption', property: 'font-size', value: '12px' },
      { path: 'styles.css', selector: '.h3', property: 'font-size', value: '20px' },
      { path: 'styles.css', selector: '.h2', property: 'font-size', value: '24px' },
      { path: 'styles.css', selector: '.h1', property: 'font-size', value: '32px' }
    ],
    htmlElements: [
      { tag: 'h1', classes: [] },
      { tag: 'h4', classes: [] }
    ],
    visual: {
      hasScreenshot: false,
      hasRegions: false,
      regionCount: 0,
      hasReceipt: false,
      limitations: []
    },
    userQuery: 'Which parts of this UI could have better spacing or visual hierarchy?'
  });

  expect(response.findings.some((f) => f.title.includes('Heading rank skipped'))).toBe(true);
  expect(response.findings.some((f) => f.title.includes('Indistinguishable font sizes'))).toBe(
    true
  );
  expect(response.recommendations.some((r) => r.id === 'rec-type-scale')).toBe(true);
});

test('DesignAnalyzer evaluates sidebar vs top navigation bar with trade-offs', () => {
  const analyzer = new DesignAnalyzer();
  const dummyCheckpoint: Checkpoint = {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    parentId: null,
    createdAt: new Date().toISOString(),
    trigger: 'baseline',
    files: [],
    attribution: { kind: 'unattributed' }
  };

  const response = analyzer.analyze({
    activeCheckpoint: dummyCheckpoint,
    targetFiles: [],
    cssDeclarations: [
      { path: 'nav.css', selector: '.sidebar', property: 'flex-direction', value: 'column' }
    ],
    htmlElements: [
      { tag: 'nav', classes: ['sidebar'] },
      { tag: 'a', classes: [] },
      { tag: 'a', classes: [] },
      { tag: 'a', classes: [] }
    ],
    visual: {
      hasScreenshot: false,
      hasRegions: false,
      regionCount: 0,
      hasReceipt: false,
      limitations: []
    },
    userQuery: 'Would a sidebar or a top navigation bar work better here?'
  });

  expect(response.directAnswer).toContain('Top Navigation Bar');
  const navRec = response.recommendations.find((r) => r.id === 'rec-nav-choice')!;
  expect(navRec.tradeOffs).toBeDefined();
  expect(navRec.rationale).toBeDefined();
  expect(navRec.suggestedCode).toContain('.nav-header');
});

test('DesignAnalyzer explains version diffs when comparing checkpoints', () => {
  const analyzer = new DesignAnalyzer();
  const cp1: Checkpoint = {
    schemaVersion: 1,
    id: '1'.repeat(64),
    parentId: null,
    createdAt: new Date().toISOString(),
    trigger: 'baseline',
    files: [],
    attribution: { kind: 'unattributed' }
  };
  const cp2: Checkpoint = {
    schemaVersion: 1,
    id: '2'.repeat(64),
    parentId: cp1.id,
    createdAt: new Date().toISOString(),
    trigger: 'save',
    files: [],
    attribution: { kind: 'unattributed' }
  };

  const response = analyzer.analyze({
    activeCheckpoint: cp2,
    compareCheckpoint: cp1,
    targetFiles: [],
    cssDeclarations: [],
    cssChanges: [
      {
        path: 'site.css',
        selector: '.navbar',
        property: 'flex-direction',
        before: 'column',
        after: 'row'
      }
    ],
    htmlElements: [],
    visual: {
      hasScreenshot: false,
      hasRegions: false,
      regionCount: 0,
      hasReceipt: false,
      limitations: []
    },
    userQuery: 'What changed in the layout between these two recorded versions?'
  });

  expect(response.directAnswer).toContain('.navbar');
  expect(response.directAnswer).toContain('column -> row');
  expect(response.findings.some((f) => f.category === 'diff_comparison')).toBe(true);
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
      }
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
