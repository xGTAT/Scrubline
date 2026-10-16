import { test, expect } from 'vitest';
import { contrastRatio, parseColor, luminance } from '../../src/chatbot/contrast';

test('parseColor resolves hex, rgb() and basic named colors', () => {
  expect(parseColor('#fff')).toEqual([255, 255, 255]);
  expect(parseColor('#ff0000')).toEqual([255, 0, 0]);
  expect(parseColor('rgb(0, 128, 255)')).toEqual([0, 128, 255]);
  expect(parseColor('navy')).toEqual([0, 0, 128]);
  expect(parseColor('rebeccapurple')).toBeUndefined(); // not a basic color: refuse, never guess
  expect(parseColor('var(--brand)')).toBeUndefined();
});

test('contrastRatio matches known WCAG reference values', () => {
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
  expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1);
  expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
  expect(luminance([0, 0, 0])).toBe(0);
});

test('analyzer flags a low-contrast rule and leaves good contrast alone', async () => {
  const { DeterministicAdvisorProvider } = await import('../../src/chatbot/advisor');
  const provider = new DeterministicAdvisorProvider();
  const base = {
    activeCheckpoint: { files: [] },
    targetFiles: [],
    cssDeclarations: [
      { path: 'site.css', selector: '.muted', property: 'color', value: '#aaaaaa' },
      { path: 'site.css', selector: '.muted', property: 'background-color', value: '#ffffff' },
      { path: 'site.css', selector: '.strong', property: 'color', value: '#000000' },
      { path: 'site.css', selector: '.strong', property: 'background-color', value: '#ffffff' }
    ],
    htmlElements: [],
    visual: {
      hasScreenshot: false,
      hasRegions: false,
      regionCount: 0,
      hasReceipt: false,
      limitations: []
    },
    userQuery: 'any accessibility concerns?'
  };
  const advice = await provider.generateAdvice(base as never);
  const clash = advice.findings.find((f) => f.title.includes('.muted'));
  expect(clash).toBeDefined();
  expect(clash!.details).toContain('4.5:1');
  expect(advice.findings.some((f) => f.title.includes('.strong'))).toBe(false);
  expect(advice.recommendations.some((r) => r.title.includes('.muted'))).toBe(true);
});
