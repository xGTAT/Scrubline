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
}
// Keep the last decoded frame visible until the newest requested image is ready.
export function FrameView({ frame, requested }: { frame?: Frame; requested?: string }) {
  const [shown, setShown] = useState<Frame>();
  const [previous, setPrevious] = useState<Frame>();
  const ticket = useRef(0);
  const latest = useRef<Frame>();
  useEffect(() => {
    const token = ++ticket.current;
    if (!frame || frame.checkpoint !== requested) return;
    const image = new Image();
    image.src = frame.image;
    void image
      .decode()
      .then(() => {
        if (token !== ticket.current) return;
        if (latest.current?.checkpoint === frame.checkpoint) return;
        setPrevious(latest.current);
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
  }, [shown]);
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
      aria-busy={shown.checkpoint !== requested}
    >
      <img className="frame-base" src={shown.image} alt="Checkpoint screenshot" />
      {previous && <img className="frame-out" src={previous.image} alt="" aria-hidden="true" />}
      {[
        [previous, outgoing, 'out'],
        [shown, incoming, 'in']
      ].map(([source, regions, direction]) =>
        (regions as Region[]).map((r) => (
          <span
            key={`${shown.checkpoint}-${direction}-${r.key}`}
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
