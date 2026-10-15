/** Opaque local covers, never an outgoing screenshot layer. */
export function changedPixelCover(before: HTMLImageElement, after: HTMLImageElement) {
  const width = before.naturalWidth,
    height = before.naturalHeight;
  if (!width || width !== after.naturalWidth || height !== after.naturalHeight) return undefined;
  const read = document.createElement('canvas');
  read.width = width;
  read.height = height;
  const ctx = read.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  try {
    ctx.drawImage(before, 0, 0);
    const a = ctx.getImageData(0, 0, width, height).data;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(after, 0, 0);
    const b = ctx.getImageData(0, 0, width, height).data;
    const tile = 12,
      cols = Math.ceil(width / tile),
      rows = Math.ceil(height / tile);
    const dirty = new Uint8Array(cols * rows);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (
          a[i] !== b[i] ||
          a[i + 1] !== b[i + 1] ||
          a[i + 2] !== b[i + 2] ||
          a[i + 3] !== b[i + 3]
        )
          dirty[Math.floor(y / tile) * cols + Math.floor(x / tile)] = 1;
      }
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const paint = mask.getContext('2d')!;
    let changed = 0;
    for (let start = 0; start < dirty.length; start++) {
      if (!dirty[start]) continue;
      const queue = [start];
      dirty[start] = 0;
      let left = cols,
        top = rows,
        right = 0,
        bottom = 0;
      for (let q = 0; q < queue.length; q++) {
        const at = queue[q],
          x = at % cols,
          y = Math.floor(at / cols);
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy,
              n = ny * cols + nx;
            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && dirty[n]) {
              dirty[n] = 0;
              queue.push(n);
            }
          }
      }
      changed += queue.length;
      left *= tile;
      top *= tile;
      right = Math.min(width, right * tile);
      bottom = Math.min(height, bottom * tile);
      const colors = new Map<number, number>();
      // Sample the surrounding surface, not each letter-sized tile. Choosing a
      // foreground color per tile creates blocky remnants during a text fade.
      for (let y = Math.max(0, top - 24); y < Math.min(height, bottom + 24); y += 3)
        for (let x = Math.max(0, left - 24); x < Math.min(width, right + 24); x += 3) {
          const i = (y * width + x) * 4,
            rgb = (a[i] << 16) | (a[i + 1] << 8) | a[i + 2];
          colors.set(rgb, (colors.get(rgb) ?? 0) + 1);
        }
      let color = 0,
        count = 0;
      for (const [rgb, n] of colors)
        if (n > count) {
          color = rgb;
          count = n;
        }
      paint.fillStyle = '#' + color.toString(16).padStart(6, '0');
      paint.fillRect(left, top, right - left, bottom - top);
    }
    return { canvas: mask, changed };
  } catch {
    // Older/cross-origin evidence still navigates via a decoded atomic swap.
    return undefined;
  }
}
