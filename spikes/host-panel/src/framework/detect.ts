// Detect frontend languages and frameworks present in a checkpoint's files.
import type { Checkpoint } from '../bridge/timeline';

export interface FrameworkReport {
  languages: string[]; // e.g. ['TypeScript', 'JSX/TSX', 'SCSS']
  frameworks: string[]; // e.g. ['React', 'Vite']
  elementSupport: string[]; // file extensions eligible for framework element restore
}

const DEP_FRAMEWORKS: [RegExp, string][] = [
  [/^react$/, 'React'],
  [/^react-dom$/, 'React'],
  [/^preact$/, 'Preact'],
  [/^solid-js$/, 'Solid'],
  [/^next$/, 'Next.js'],
  [/^vue$/, 'Vue'],
  [/^nuxt$/, 'Nuxt'],
  [/^svelte$/, 'Svelte'],
  [/^@sveltejs\/kit$/, 'SvelteKit'],
  [/^astro$/, 'Astro'],
  [/^@angular\/core$/, 'Angular'],
  [/^qwik$/, 'Qwik'],
  [/^@builder\.io\/qwik$/, 'Qwik'],
  [/^vite$/, 'Vite'],
  [/^tailwindcss$/, 'Tailwind CSS'],
  [/^styled-components$/, 'styled-components'],
  [/^@emotion\/react$/, 'Emotion']
];

export function detectFrameworks(
  checkpoint: Checkpoint,
  read: (hash: string) => Promise<Buffer>
): Promise<FrameworkReport> {
  return (async () => {
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const elementSupport = new Set<string>();
    for (const f of checkpoint.files) {
      const p = f.path.toLowerCase();
      if (p.endsWith('.ts') || p.endsWith('.tsx')) languages.add('TypeScript');
      if (p.endsWith('.js') || p.endsWith('.jsx')) languages.add('JavaScript');
      if (p.endsWith('.jsx') || p.endsWith('.tsx')) {
        languages.add('JSX/TSX');
        elementSupport.add(p.endsWith('.jsx') ? '.jsx' : '.tsx');
      }
      if (p.endsWith('.vue')) elementSupport.add('.vue');
      if (p.endsWith('.svelte')) elementSupport.add('.svelte');
      if (p.endsWith('.astro')) elementSupport.add('.astro');
      if (p.endsWith('.html')) elementSupport.add('.html');
      if (p.endsWith('.scss')) languages.add('SCSS');
      if (p.endsWith('.less')) languages.add('Less');
      if (p.endsWith('.css')) languages.add('CSS');
      if (p.endsWith('package.json')) {
        try {
          const pkg = JSON.parse((await read(f.hash)).toString('utf8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          for (const name of Object.keys(deps))
            for (const [re, label] of DEP_FRAMEWORKS) if (re.test(name)) frameworks.add(label);
        } catch {
          // Unparseable package.json is not evidence.
        }
      }
    }
    return {
      languages: [...languages].sort(),
      frameworks: [...frameworks].sort(),
      elementSupport: [...elementSupport].sort()
    };
  })();
}
