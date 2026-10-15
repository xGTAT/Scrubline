import React, { useEffect, useRef, useState } from 'react';
import { regionChanges, focusedChanges } from './regions';
export interface Region {
  key: string;
  signature: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Frame {
  checkpoint: string;
  image: string;
  width?: number;
  height?: number;
  receipt?: import('../evidence/types').RenderReceipt;
  regions?: Region[];
  comparison?: { checkpoint: string; regions: Region[] };
}
// Keep the last decoded frame visible until the newest requested image is ready.
export function FrameView({ frame, requested }: { frame?: Frame; requested?: string }) {
  const [shown, setShown] = useState<Frame>();
  const ticket = useRef(0);
  const shownRef = useRef<Frame>();
  const requestedRef = useRef(requested);
  requestedRef.current = requested;
  const veil = useRef<HTMLDivElement>(null);
  const decodedImages = useRef(new Map<string, HTMLImageElement>());
  const animation = useRef<number>();
  const composite = useRef<HTMLCanvasElement>();
  useEffect(
    () => () => {
      if (animation.current) cancelAnimationFrame(animation.current);
    },
    []
  );
  const display = (decoded: Frame) => {
    if (decoded.checkpoint !== requestedRef.current) return;
    const previous = shownRef.current;
    const nextImage = decodedImages.current.get(decoded.image);
    const oldImage = previous && decodedImages.current.get(previous.image);
    const host = veil.current;
    const active = composite.current;
    if (animation.current) cancelAnimationFrame(animation.current);
    animation.current = undefined;
    let start: HTMLCanvasElement | HTMLImageElement | undefined = active ?? oldImage;
    // Continue from the exact on-screen blend when a newer decode interrupts.
    if (active) {
      const snapshot = document.createElement('canvas');
      snapshot.width = active.width;
      snapshot.height = active.height;
      snapshot.getContext('2d')?.drawImage(active, 0, 0);
      start = snapshot;
    }
    composite.current = undefined;
    host?.replaceChildren();
    shownRef.current = decoded;
    setShown(decoded);
    if (
      !host ||
      !start ||
      !nextImage ||
      !previous ||
      previous.image === decoded.image ||
      matchMedia('(prefers-reduced-motion: reduce)').matches ||
      (start instanceof HTMLImageElement ? start.naturalWidth : start.width) !==
        nextImage.naturalWidth ||
      (start instanceof HTMLImageElement ? start.naturalHeight : start.height) !==
        nextImage.naturalHeight
    )
      return;
    const canvas = document.createElement('canvas');
    canvas.width = nextImage.naturalWidth;
    canvas.height = nextImage.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.setAttribute('aria-hidden', 'true');
    ctx.drawImage(start, 0, 0);
    host.append(canvas);
    composite.current = canvas;
    const began = performance.now();
    const from = start;
    const draw = (now: number) => {
      const progress = Math.min(1, (now - began) / 200);
      const blend = 1 - (1 - progress) * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(from, 0, 0);
      ctx.globalAlpha = blend;
      ctx.drawImage(nextImage, 0, 0);
      ctx.globalAlpha = 1;
      if (progress < 1) animation.current = requestAnimationFrame(draw);
      else {
        animation.current = undefined;
        composite.current = undefined;
        host.replaceChildren();
      }
    };
    animation.current = requestAnimationFrame(draw);
  };
  const figure = useRef<HTMLElement>(null);
  const [highlights, setHighlights] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [oldPosition, setOldPosition] = useState(false);
  useEffect(() => {
    setFocusIndex(0);
    setOldPosition(false);
  }, [requested]);
  useEffect(() => {
    const token = ++ticket.current;
    if (!frame || frame.checkpoint !== requested) return;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = frame.image;
    void image
      .decode()
      .then(() => {
        if (token !== ticket.current) return;
        const decoded = { ...frame, width: image.naturalWidth, height: image.naturalHeight };
        decodedImages.current.set(decoded.image, image);
        // Retain only shown, pending and newest decoded screenshots.
        for (const key of decodedImages.current.keys())
          if (
            ![
              decoded.image,
              shownRef.current?.image,
              composite.current ? shownRef.current?.image : undefined
            ].includes(key)
          )
            decodedImages.current.delete(key);
        display(decoded);
      })
      .catch(() => {});
    return () => {
      ticket.current++;
    };
  }, [frame?.image, frame?.checkpoint, requested, frame?.receipt?.imageHash]);
  if (!shown) return null;
  const marks = shown.comparison
    ? regionChanges(shown.comparison.regions, shown.regions ?? [])
    : [];
  const significant = focusedChanges(marks);
  const focused = significant[Math.min(focusIndex, Math.max(0, significant.length - 1))];
  const focusRegion = oldPosition && focused?.old ? focused.old : focused?.region;
  const box = (r: Region) => ({
    left: `${(r.x / (shown.width ?? 960)) * 100}%`,
    top: `${(r.y / (shown.height ?? 600)) * 100}%`,
    width: `${(r.width / (shown.width ?? 960)) * 100}%`,
    height: `${(r.height / (shown.height ?? 600)) * 100}%`
  });
  return (
    <figure
      className="frame"
      style={{
        aspectRatio: `${shown.width ?? 960} / ${shown.height ?? 600}`,
        maxWidth:
          (shown.width ?? 960) < (shown.height ?? 600)
            ? `${Math.round((600 * (shown.width ?? 960)) / (shown.height ?? 600))}px`
            : undefined,
        marginInline: 'auto',
        width: '100%'
      }}
      data-checkpoint={shown.checkpoint}
      ref={figure}
      aria-busy={shown.checkpoint !== requested}
    >
      <img
        className="frame-base"
        crossOrigin="anonymous"
        src={shown.image}
        alt="Checkpoint screenshot"
      />
      <div ref={veil} className="frame-veil" aria-hidden="true" />
      {highlights && shown.checkpoint === requested && focusRegion && (
        <span
          aria-hidden="true"
          className={`change-focus change-focus-${focused.kind}`}
          style={box(focusRegion)}
        />
      )}
      {shown.comparison && (
        <figcaption className="highlight-controls">
          <button
            className="changes-toggle"
            aria-pressed={highlights}
            disabled={shown.checkpoint !== requested || !significant.length}
            onClick={() => setHighlights(!highlights)}
          >
            {highlights ? 'Hide changes' : `${significant.length} changes`}
          </button>
          {highlights && focused && shown.checkpoint === requested && (
            <>
              <button
                aria-label="Previous change"
                disabled={focusIndex === 0}
                onClick={() => {
                  setFocusIndex(Math.max(0, focusIndex - 1));
                  setOldPosition(false);
                }}
              >
                ‹
              </button>
              <span role="status">
                {Math.min(focusIndex + 1, significant.length)} / {significant.length} ·{' '}
                {focused.kind}
              </span>
              <button
                aria-label="Next change"
                disabled={focusIndex >= significant.length - 1}
                onClick={() => {
                  setFocusIndex(Math.min(significant.length - 1, focusIndex + 1));
                  setOldPosition(false);
                }}
              >
                ›
              </button>
              {focused.old && (
                <button aria-pressed={oldPosition} onClick={() => setOldPosition(!oldPosition)}>
                  {oldPosition ? 'Current position' : 'Previous position'}
                </button>
              )}
            </>
          )}
        </figcaption>
      )}
      <figcaption className="frame-caption">
        {shown.checkpoint !== requested ? 'Loading selected checkpoint…' : 'Read-only screenshot'}
      </figcaption>
    </figure>
  );
}
