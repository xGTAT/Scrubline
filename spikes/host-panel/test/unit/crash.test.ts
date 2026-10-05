import { test, expect } from 'vitest';
import { build } from 'esbuild';
import { fork } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryStore } from '../../src/store/store';
import { scan } from '../../src/capture/scanner';
for (const point of ['before', 'after'])
  test(`kill writer ${point} manifest commit: restart never accepts half a checkpoint`, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-crash-'));
    const root = path.join(temp, 'project');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'index.txt'), 'baseline');
    const store = new HistoryStore(path.join(temp, 'history'));
    await store.open();
    const initial = await scan(root, store.root);
    await store.commit(initial.files, initial.contents, 'baseline', { kind: 'unattributed' });
    await fs.writeFile(path.join(root, 'index.txt'), 'new content');
    try {
      const bundle = path.join(temp, 'engine.cjs');
      await build({
        stdin: {
          contents:
            "export {HistoryStore} from './src/store/store'; export {scan} from './src/capture/scanner';",
          resolveDir: process.cwd()
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle
      });
      const childFile = path.join(temp, 'writer.cjs');
      await fs.writeFile(
        childFile,
        `
const fs=require('node:fs/promises');
const rename=fs.rename;fs.rename=async function(a,b){if(b.includes('manifests') && b.endsWith('.json')){if(process.argv[5]==='before'){process.send('paused');await new Promise(()=>{});}await rename(a,b);process.send('paused');await new Promise(()=>{});}return rename(a,b);};
const {HistoryStore,scan}=require(process.argv[2]);
(async()=>{const store=new HistoryStore(process.argv[4]);await store.acquireWriter();await store.open();const s=await scan(process.argv[3],store.root);await store.commit(s.files,s.contents,'watcher',{kind:'unattributed'});})().catch(e=>{console.error(e);process.exit(1);});`
      );
      const child = fork(childFile, [bundle, root, store.root, point], { silent: true });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('writer did not reach crash point'));
        }, 10000);
        child.once('message', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`writer exited ${code}`));
        });
      });
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      const restart = new HistoryStore(store.root);
      await restart.acquireWriter();
      const recovered = await restart.open();
      expect(recovered.length).toBe(point === 'before' ? 1 : 2);
      for (const c of recovered) {
        const dest = path.join(temp, c.id);
        await restart.materialize(c, dest);
        const checked = await scan(dest, store.root);
        expect(checked.files.map((f) => f.hash)).toEqual(c.files.map((f) => f.hash));
      }
      await restart.releaseWriter();
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }, 20000);
