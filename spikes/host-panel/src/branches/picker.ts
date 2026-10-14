import { chromium, type Browser } from 'playwright-core';
import { installOverlay } from '../targeting/overlay';
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
    picked: (path: number[]) => Promise<void>,
    stopped: () => Promise<void>
  ) {
    await this.stop();
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('Local preview required.');
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
      const indices = await page.locator(value.selector).evaluate((el) => {
        const path: number[] = [];
        let n: Element | null = el;
        while (n && n !== document.body) {
          const parent: Element | null = n.parentElement;
          if (!parent) throw Error('No body ownership');
          path.unshift([...parent.children].indexOf(n));
          n = parent;
        }
        return path;
      });
      await picked(indices);
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
