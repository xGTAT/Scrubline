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
