import React from 'react';
import { Card } from './components/Card';
import './styles/app.scss';

const items = [
  { id: 1, title: 'Alpha' },
  { id: 2, title: 'Beta' }
];

export function App() {
  return (
    <main className="app">
      <nav id="top-nav" className="nav">
        <a href="/">Home</a>
        <a href="/about">About</a>
      </nav>
      <section className="hero" style={{ padding: 8 }}>
        <h1 data-testid="title">Hello world</h1>
        <p className="tagline">Old tagline</p>
      </section>
      <ul className="cards">
        {items.map((it) => (
          <Card key={it.id} title={it.title} />
        ))}
      </ul>
    </main>
  );
}
