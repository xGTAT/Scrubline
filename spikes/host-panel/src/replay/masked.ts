import type { ReplayFrame } from './export';
// Export geometry, never project pixels, markup, text, attributes or URLs.
export async function maskedFrame(url: string, executablePath: string): Promise<ReplayFrame> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1')
    throw new Error('Replay requires a local preview.');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-gpu']
  });
  try {
    const source = await browser.newPage({ viewport: { width: 960, height: 600 } });
    await source.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    if (new URL(source.url()).origin !== parsed.origin)
      throw new Error('Replay preview redirected.');
    const boxes = await source.evaluate(() => {
      const allowed = new Set([
        'NAV',
        'HEADER',
        'FOOTER',
        'MAIN',
        'SECTION',
        'ARTICLE',
        'DIV',
        'BUTTON',
        'INPUT',
        'IMG',
        'VIDEO',
        'CANVAS',
        'H1',
        'H2',
        'H3',
        'P',
        'A'
      ]);
      const result: { x: number; y: number; w: number; h: number; role: number }[] = [];
      for (const el of [...document.querySelectorAll('body *')].slice(0, 5000)) {
        if (!allowed.has(el.tagName)) continue;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (
          r.width < 4 ||
          r.height < 4 ||
          r.right <= 0 ||
          r.bottom <= 0 ||
          r.x >= 960 ||
          r.y >= 600 ||
          style.visibility === 'hidden' ||
          style.display === 'none'
        )
          continue;
        result.push({
          x: Math.max(0, Math.round(r.x)),
          y: Math.max(0, Math.round(r.y)),
          w: Math.min(960, Math.round(r.width)),
          h: Math.min(600, Math.round(r.height)),
          role: ['BUTTON', 'INPUT', 'A'].includes(el.tagName) ? 1 : 0
        });
        if (result.length >= 500) break;
      }
      return result;
    });
    await source.close();
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(
      '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f3f4f6"><canvas width="960" height="600"></canvas></body>'
    );
    await page.evaluate((boxes) => {
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(0, 0, 960, 600);
      for (const b of boxes) {
        ctx.fillStyle = b.role ? '#b0c6e8' : '#e3e7ed';
        ctx.strokeStyle = '#bac2ce';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(b.x + 2, b.y + 2, Math.max(1, b.w - 4), Math.max(1, b.h - 4), 5);
        ctx.fill();
        ctx.stroke();
      }
    }, boxes);
    const png = await page.screenshot();
    // Identity is exact masked layout, not a claim of semantic element mapping.
    return { png, identity: JSON.stringify(boxes) };
  } finally {
    await browser.close();
  }
}

// Local replay export ends here.
