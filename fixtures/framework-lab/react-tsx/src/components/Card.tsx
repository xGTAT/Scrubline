import React from 'react';

export function Card({ title }: { title: string }) {
  return (
    <li className="card">
      <h2 data-testid="card-title">{title}</h2>
      <button className="cta bg-blue-500 text-white">Open</button>
    </li>
  );
}
