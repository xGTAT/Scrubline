import React, { useEffect, useRef, useState } from 'react';
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
  regions?: Region[];
  composite?: HTMLCanvasElement;
}
// Keep the last decoded frame visible until the newest requested image is ready.
export function FrameView({ frame, requested }: { frame?: Frame; requested?: string }) {
  const [shown, setShown] = useState<Frame>();
  const [previous, setPrevious] = useState<Frame>();
  const ticket = useRef(0);
  const latest = useRef<Frame>();
  const figure = useRef<HTMLElement>(null);
  const [transition, setTransition] = useState(0);
  const composited = (): Frame | undefined => {
    const current = latest.current;
    if (!current) return;
    const base = figure.current?.querySelector<HTMLImageElement>('.frame-base');
    const outgoing = figure.current?.querySelector<HTMLImageElement | HTMLCanvasElement>(
      '.frame-out'
    );
    if (!base || !outgoing) return current;
    // Continue from the pixels currently on screen, not the last full screenshot.
    // Otherwise a new frame during a fade jumps back to its unfaded predecessor.
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 600;
      const ctx = canvas.getContext('2d');
      if (!ctx) return current;
      ctx.drawImage(base, 0, 0, 960, 600);
      ctx.globalAlpha = Number(getComputedStyle(outgoing).opacity);
      ctx.drawImage(outgoing, 0, 0, 960, 600);
      const bounds = figure.current!.getBoundingClientRect();
      for (const region of figure.current!.querySelectorAll<HTMLElement>('.region')) {
        const image = region.querySelector<HTMLImageElement>('img');
        if (!image || !image.complete) continue;
        const clip = region.getBoundingClientRect();
        const pixels = image.getBoundingClientRect();
        const sx = 960 / bounds.width,
          sy = 600 / bounds.height;
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          (clip.x - bounds.x) * sx,
          (clip.y - bounds.y) * sy,
          clip.width * sx,
          clip.height * sy
        );
        ctx.clip();
        ctx.globalAlpha = Number(getComputedStyle(region).opacity);
        ctx.drawImage(
          image,
          (pixels.x - bounds.x) * sx,
          (pixels.y - bounds.y) * sy,
          pixels.width * sx,
          pixels.height * sy
        );
        ctx.restore();
      }
      // Pixels already include region motion: don't crop/animate them again.
      return { ...current, regions: [], composite: canvas };
    } catch {
      return current;
    }
  };
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
        if (latest.current?.checkpoint === frame.checkpoint) return;
        setPrevious(composited());
        setTransition((n) => n + 1);
        latest.current = frame;
        setShown(frame);
      })
      .catch(() => {});
    return () => {
      ticket.current++;
    };
  }, [frame?.image, frame?.checkpoint, requested]);
  useEffect(() => {
    const timer = setTimeout(() => setPrevious(undefined), 220);
    return () => clearTimeout(timer);
  }, [shown, transition]);
  useEffect(() => {
    if (!previous?.composite) return;
    const target = figure.current?.querySelector<HTMLCanvasElement>('canvas.frame-out');
    target?.getContext('2d')?.drawImage(previous.composite, 0, 0);
  }, [previous, transition]);
  if (!shown) return null;
  const changed = (a: Region[], b: Region[]) =>
    a
      .filter((r) => {
        const match = b.find((other) => other.key === r.key);
        return (
          !match ||
          match.signature !== r.signature ||
          Math.abs(match.x - r.x) > 1 ||
          Math.abs(match.y - r.y) > 1
        );
      })
      .slice(0, 24);
  const outgoing = previous ? changed(previous.regions ?? [], shown.regions ?? []) : [];
  const incoming = previous ? changed(shown.regions ?? [], previous.regions ?? []) : [];
  return (
    <figure
      className="frame"
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
      {previous &&
        (previous.composite ? (
          <canvas
            key={transition}
            className="frame-out"
            width={960}
            height={600}
            aria-hidden="true"
          />
        ) : (
          <img
            key={transition}
            className="frame-out"
            crossOrigin="anonymous"
            src={previous.image}
            alt=""
            aria-hidden="true"
          />
        ))}
      {[
        [previous, outgoing, 'out'],
        [shown, incoming, 'in']
      ].map(([source, regions, direction]) =>
        (regions as Region[]).map((r) => (
          <span
            key={`${shown.checkpoint}-${transition}-${direction}-${r.key}`}
            className={`region region-${direction}`}
            aria-hidden="true"
            style={{
              left: `${r.x / 9.6}%`,
              top: `${r.y / 6}%`,
              width: `${r.width / 9.6}%`,
              height: `${r.height / 6}%`
            }}
          >
            <img
              crossOrigin="anonymous"
              src={(source as Frame).image}
              alt=""
              style={{
                width: `${(960 / r.width) * 100}%`,
                height: `${(600 / r.height) * 100}%`,
                left: `${(-r.x / r.width) * 100}%`,
                top: `${(-r.y / r.height) * 100}%`
              }}
            />
          </span>
        ))
      )}
      <figcaption className="frame-caption">
        {shown.checkpoint !== requested ? 'Loading selected checkpoint…' : 'Read-only screenshot'}
      </figcaption>
    </figure>
  );
}
