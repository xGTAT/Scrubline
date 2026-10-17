import * as vscode from 'vscode';
import { chromium, type Browser } from 'playwright-core';
import { installOverlay } from '../targeting/overlay';
import { fiberSourceScript, type FiberPick } from './fiber-source';
export interface PickedInfo {
  tag: string;
  id?: string;
  testId?: string;
  name?: string;
  text?: string;
  href?: string;
}
export class ElementPicker {
  private browser?: Browser;
  async stop() {
    await this.browser?.close();
    this.browser = undefined;
  }
  async start(
    executable: string,
    url: string,
    viewport: { width: number; height: number },
    picked: (path: number[], info: PickedInfo, framework?: FiberPick) => Promise<void>,
    stopped: () => Promise<void>
  ) {
    await this.stop();
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Local preview required.');
    this.browser = await chromium.launch({
      executablePath: executable,
      headless: false,
      args: ['--disable-gpu']
    });
    const page = await this.browser.newPage({ viewport });
    page.on('close', () => {
      void stopped();
    });
    await page.exposeBinding('__scrublineStopped', async () => {
      await this.stop();
      await stopped();
    });
    await page.exposeBinding('__scrublineSelect', async (_source, value: { selector: string }) => {
      try {
        // Playwright cannot serialize a function passed as an evaluate argument;
        // ship the fiber reader as source and rebuild it inside the page.
        const { indices, info, framework } = await page
          .locator(value.selector)
          .evaluate((el, fiberSourceCode) => {
            const fiberSource = new Function(`return (${fiberSourceCode})`)() as (
              el: Element
            ) => FiberPick;
            const path: number[] = [];
            let n: Element | null = el;
            while (n && n !== document.body) {
              const parent: Element | null = n.parentElement;
              if (!parent) throw Error('No body ownership');
              path.unshift([...parent.children].indexOf(n));
              n = parent;
            }
            const info = {
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              testId: el.getAttribute('data-testid') ?? undefined,
              name: el.getAttribute('aria-label') ?? undefined,
              text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined,
              href: el.getAttribute('href') ?? undefined
            };
            return { indices: path, info, framework: fiberSource(el) };
          }, String(fiberSourceScript));
        await picked(indices, info, framework);
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Element pick failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    });
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (
        u.origin !== new URL(url).origin ||
        (route.request().isNavigationRequest() && route.request().url() !== url)
      )
        await route.abort();
      else await route.continue();
    });
    await page.goto(url);
    await page.evaluate(installOverlay);
  }
}
