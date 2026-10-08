import type { Browser, Page } from 'playwright-core';
import * as path from 'node:path';
import { atomicWrite } from '../store/store';
import type { Selection } from './packet';
import { installOverlay } from './overlay';
import { redact } from './redact';
export class TargetSession {
  private browser?: Browser;
  private page?: Page;
  private selection?: Selection;
  private activeOrigin?: string;

  constructor(
    readonly executable: string,
    readonly storeRoot: string,
    readonly notify: (value: Selection, crop?: string) => void,
    readonly unavailable: (message: string) => void
  ) {}
  async start(url: string, secrets: readonly string[], headless = false) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1')
      throw new Error('Targeting requires a local preview.');
    await this.stop();
    this.activeOrigin = parsed.origin;
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.launch({
      executablePath: this.executable,
      headless,
      args: ['--disable-gpu']
    });
    this.page = await this.browser.newPage({ viewport: { width: 960, height: 600 } });
    const page = this.page;
    await page.exposeBinding('__scrublineStopped', () => this.unavailable('Targeting stopped.'));
    await page.exposeBinding('__scrublineSelect', async (source, value: Selection) => {
      if (source.frame !== page.mainFrame() || new URL(page.url()).origin !== this.activeOrigin)
        return;
      if (
        !value ||
        typeof value.selector !== 'string' ||
        value.selector.length > 1000 ||
        typeof value.fingerprint !== 'string' ||
        !['tag', 'name', 'snippet', 'route'].every(
          (k) => typeof (value as unknown as Record<string, unknown>)[k] === 'string'
        )
      )
        return;
      this.selection = value;
      let crop: string | undefined;
      let cropPage: Page | undefined;
      try {
        const element = page.locator(value.selector);
        const source = await element.evaluate((el) => {
          const clone = el.cloneNode(true) as Element;
          const originals = [el, ...el.querySelectorAll('*')];
          const copies = [clone, ...clone.querySelectorAll('*')];
          const properties = [
            'color',
            'background-color',
            'font-size',
            'font-weight',
            'font-family',
            'line-height',
            'padding',
            'border-radius',
            'display',
            'text-align'
          ];
          for (let i = 0; i < copies.length; i++) {
            const copy = copies[i],
              original = originals[i];
            for (const attr of [...copy.attributes]) copy.removeAttribute(attr.name);
            if (
              ![
                'DIV',
                'SPAN',
                'P',
                'BUTTON',
                'A',
                'H1',
                'H2',
                'H3',
                'H4',
                'UL',
                'OL',
                'LI',
                'STRONG',
                'EM',
                'SMALL',
                'LABEL'
              ].includes(copy.tagName)
            ) {
              copy.textContent = '[media or control hidden]';
              for (const child of [...copy.children]) child.remove();
            }
            const styles = getComputedStyle(original);
            const safeStyle = properties.map((p) => `${p}:${styles.getPropertyValue(p)}`).join(';');
            copy.setAttribute('style', safeStyle);
          }
          // Serialize only inert tags. Unknown tags become spans; no URLs, scripts or CSS content.
          const inert = document.createElement('div');
          function append(node: Node, parent: Element) {
            if (node.nodeType === Node.TEXT_NODE) {
              parent.append(document.createTextNode(node.textContent ?? ''));
              return;
            }
            if (!(node instanceof Element)) return;
            const allowed = [
              'DIV',
              'SPAN',
              'P',
              'BUTTON',
              'A',
              'H1',
              'H2',
              'H3',
              'H4',
              'UL',
              'OL',
              'LI',
              'STRONG',
              'EM',
              'SMALL',
              'LABEL'
            ];
            const safe = document.createElement(
              allowed.includes(node.tagName) ? node.tagName.toLowerCase() : 'span'
            );
            safe.setAttribute('style', node.getAttribute('style') ?? '');
            parent.append(safe);
            for (const child of [...node.childNodes]) append(child, safe);
          }
          append(clone, inert);
          // Keep inherited solid background without copying URLs or page content.
          const layers: number[][] = [];
          for (let node: Element | null = el; node; node = node.parentElement) {
            const channels = getComputedStyle(node)
              .backgroundColor.match(/[\d.]+/g)
              ?.map(Number);
            if (channels && channels.length >= 3) layers.push(channels);
          }
          let background = [255, 255, 255];
          for (const layer of layers.reverse()) {
            const alpha = Math.min(1, Math.max(0, layer[3] ?? 1));
            background = background.map((v, i) => Math.round(layer[i] * alpha + v * (1 - alpha)));
          }
          return {
            background: `rgb(${background.join(',')})`,
            html: inert.innerHTML,
            width: Math.min(960, Math.max(100, el.getBoundingClientRect().width))
          };
        });
        cropPage = await this.browser!.newPage({
          viewport: { width: Math.ceil(source.width) + 32, height: 600 }
        });
        await cropPage.setContent(
          '<!doctype html><meta charset="utf-8"><body style="margin:16px"></body>'
        );
        await cropPage.evaluate((source) => {
          document.body.style.backgroundColor = source.background;
          document.body.innerHTML = source.html;
        }, source);
        const texts = await cropPage.locator('body').evaluate((el) => {
          const words: string[] = [];
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walk.nextNode())) words.push(node.textContent ?? '');
          return words;
        });
        let replacements = texts.map((text) => redact(text, secrets));
        const joined = texts.join('');
        if (redact(joined, secrets) !== joined) {
          replacements = [redact(joined, secrets), ...texts.slice(1).map(() => '')];
        }
        await cropPage.locator('body').evaluate((el, replacements) => {
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          let i = 0;
          while ((node = walk.nextNode())) node.textContent = replacements[i++];
        }, replacements);
        const bytes = await cropPage.locator('body').screenshot({ timeout: 3000 });
        crop = path.join(this.storeRoot, 'targets', `${Date.now()}.png`);
        await atomicWrite(crop, bytes);
      } catch {
        /* Text packet remains available when sanitized crop cannot be made. */
      } finally {
        await cropPage?.close().catch(() => {});
      }
      if (this.page === page && this.selection === value) this.notify(value, crop);
    });
    await page.addInitScript({
      content: `const __name=(fn)=>fn;if(window===window.top&&location.origin===${JSON.stringify(parsed.origin)})(${installOverlay.toString()})();`
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (new URL(page.url()).origin !== this.activeOrigin) {
      await this.stop();
      throw new Error('Preview redirected off origin.');
    }
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && new URL(page.url()).origin !== this.activeOrigin) {
        void page.close();
        this.unavailable('Preview navigated off origin. Targeting stopped.');
      }
    });
    page.on('close', () => this.unavailable('Targeting stopped.'));
  }
  async validate(): Promise<boolean> {
    if (!this.page || !this.selection) return false;
    const selected = this.selection;
    return this.page
      .evaluate((selected) => {
        try {
          const all = document.querySelectorAll(selected.selector);
          if (all.length !== 1) return false;
          const e = all[0];
          const fingerprint = JSON.stringify({
            tag: e.tagName,
            name: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 300),
            id: e.id,
            testid: e.getAttribute('data-testid'),
            role: e.getAttribute('role'),
            href: e.getAttribute('href')
          });
          return fingerprint === selected.fingerprint;
        } catch {
          return false;
        }
      }, selected)
      .catch(() => false);
  }
  async stop() {
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    this.selection = undefined;
    await browser?.close();
    const fs = await import('node:fs/promises');
    await fs.rm(path.join(this.storeRoot, 'targets'), { recursive: true, force: true });
  }
}
