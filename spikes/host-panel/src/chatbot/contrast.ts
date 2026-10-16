// WCAG 2.x contrast ratio between two CSS colors. Heuristic: only literal
// colors resolve (hex, rgb()/rgba(), the 16 basic named colors). Gradients,
// var(), inheritance and opacity are not modeled - callers must present low
// ratios as advisory, never as verdicts.

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255]
};

export function parseColor(value: string): [number, number, number] | undefined {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    const full =
      hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex.slice(0, 6);
    if (full.length === 6)
      return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16)
      ];
    return undefined;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(v);
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (channels.every((c) => c >= 0 && c <= 255)) return channels as [number, number, number];
    return undefined;
  }
  return NAMED[v];
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

export function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
