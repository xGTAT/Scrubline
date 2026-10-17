import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { HistoryStore } from '../../src/store/store';
import { ChatbotController } from '../../src/chatbot/controller';
import { DesignAdvisorService } from '../../src/chatbot/advisor';

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

function hashFile(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('proof of read-only: chatbot source files contain zero write, restore, or exec calls', async () => {
  const chatbotDir = path.resolve(__dirname, '../../src/chatbot');
  const files = await fs.readdir(chatbotDir);
  const tsFiles = files.filter((f) => f.endsWith('.ts'));

  expect(tsFiles.length).toBeGreaterThan(0);

  const forbiddenCalls = [
    'fs.writeFile',
    'fs.promises.writeFile',
    'writeFileSync',
    'fs.rm',
    'fs.rmSync',
    'fs.unlink',
    'fs.unlinkSync',
    'fs.mkdir',
    'fs.mkdirSync',
    'atomicWrite',
    'child_process',
    'execSync',
    'spawnSync',
    'restore.apply',
    'restore.undo',
    'applySelective'
  ];

  for (const file of tsFiles) {
    const content = await fs.readFile(path.join(chatbotDir, file), 'utf8');
    for (const forbidden of forbiddenCalls) {
      expect(
        content.includes(forbidden),
        `Chatbot file ${file} must not contain forbidden write/exec call: ${forbidden}`
      ).toBe(false);
    }
  }
});

test('proof of read-only: chatbot requests leave workspace files 100% byte-identical', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-ws-immutability-'));
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-store-immutability-'));

  try {
    const htmlPath = path.join(workspaceRoot, 'index.html');
    const cssPath = path.join(workspaceRoot, 'style.css');

    const originalHtml =
      '<!DOCTYPE html><html><body><header class="header"><h1>Site</h1></header></body></html>';
    const originalCss = '.header { display: flex; padding: 10px; margin-top: -5px; }';

    await fs.writeFile(htmlPath, originalHtml, 'utf8');
    await fs.writeFile(cssPath, originalCss, 'utf8');

    const htmlBeforeHash = hashFile(await fs.readFile(htmlPath));
    const cssBeforeHash = hashFile(await fs.readFile(cssPath));
    const entriesBefore = (await fs.readdir(workspaceRoot)).sort();

    const store = new HistoryStore(storeRoot);
    await store.acquireWriter();
    await store.open();

    const cp = await store.commit(
      [
        {
          path: 'index.html',
          hash: htmlBeforeHash,
          size: Buffer.byteLength(originalHtml),
          mode: 0o644
        },
        {
          path: 'style.css',
          hash: cssBeforeHash,
          size: Buffer.byteLength(originalCss),
          mode: 0o644
        }
      ],
      new Map([
        ['index.html', Buffer.from(originalHtml)],
        ['style.css', Buffer.from(originalCss)]
      ]),
      'baseline',
      { kind: 'unattributed' }
    );

    const controller = new ChatbotController(
      store,
      () => undefined,
      async () => [],
      () => {},
      stubAdvisorService()
    );

    // Run multiple potentially invasive-sounding queries
    const advisoryPrompts = [
      'Fix this layout for me immediately and remove negative margins.',
      'Change style.css to use a dark background color.',
      'Delete the header from index.html.',
      'Restore the previous version of style.css.'
    ];

    for (const prompt of advisoryPrompts) {
      const response = await controller.handleQuery(prompt, cp.id);
      expect(response).toBeDefined();
      expect(response.directAnswer).toBeDefined();
    }

    // Verify workspace immutability
    const entriesAfter = (await fs.readdir(workspaceRoot)).sort();
    expect(entriesAfter).toEqual(entriesBefore);

    const htmlAfterBytes = await fs.readFile(htmlPath);
    const cssAfterBytes = await fs.readFile(cssPath);

    expect(hashFile(htmlAfterBytes)).toBe(htmlBeforeHash);
    expect(hashFile(cssAfterBytes)).toBe(cssBeforeHash);
    expect(htmlAfterBytes.toString('utf8')).toBe(originalHtml);
    expect(cssAfterBytes.toString('utf8')).toBe(originalCss);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(storeRoot, { recursive: true, force: true });
  }
});
