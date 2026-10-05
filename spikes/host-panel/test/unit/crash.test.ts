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
for (const point of ['backup', 'written'])
  test(`restore killed after ${point}: recover keeps exact safety bytes`, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-restore-crash-'));
    const root = path.join(temp, 'project');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'a'), 'older');
    const store = new HistoryStore(path.join(temp, 'history'));
    await store.open();
    let source = await scan(root, store.root);
    const earlier = await store.commit(source.files, source.contents, 'baseline', {
      kind: 'unattributed'
    });
    await fs.writeFile(path.join(root, 'a'), 'newer');
    source = await scan(root, store.root);
    await store.commit(source.files, source.contents, 'watcher', { kind: 'unattributed' });
    try {
      const bundle = path.join(temp, 'engine.cjs');
      await build({
        stdin: {
          contents:
            "export {HistoryStore} from './src/store/store';export {Restore} from './src/review/restore';export {defaultLimits} from './src/capture/scanner';",
          resolveDir: process.cwd()
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle
      });
      const childFile = path.join(temp, 'restore.cjs');
      await fs.writeFile(
        childFile,
        `
const fs=require('node:fs/promises');const rename=fs.rename;const copy=fs.copyFile;
fs.rename=async(a,b)=>{await rename(a,b);if(process.argv[5]==='backup' && b.includes('backup')){process.send('paused');await new Promise(()=>{});}};
fs.copyFile=async(a,b,...args)=>{await copy(a,b,...args);if(process.argv[5]==='written' && a.includes('stage')){process.send('paused');await new Promise(()=>{});}};
const {HistoryStore,Restore,defaultLimits}=require(process.argv[2]);(async()=>{const store=new HistoryStore(process.argv[4]);await store.acquireWriter();await store.open();const r=new Restore(process.argv[3],store,defaultLimits);const target=store.checkpoints[0];const review=await r.review(target,store.checkpoints.at(-1),false);await r.apply(review.token,target,false);})().catch(e=>{console.error(e);process.exit(1)});
`
      );
      const child = fork(childFile, [bundle, root, store.root, point], { silent: true });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Restore crash point not reached'));
        }, 10000);
        child.once('message', () => {
          clearTimeout(timer);
          resolve();
        });
        child.once('exit', (c) => {
          clearTimeout(timer);
          reject(new Error(`restore exited ${c}`));
        });
      });
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      const reopened = new HistoryStore(store.root);
      await reopened.acquireWriter();
      await reopened.open();
      const { Restore } = await import('../../src/review/restore');
      const { defaultLimits } = await import('../../src/capture/scanner');
      await new Restore(root, reopened, defaultLimits).recover();
      expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('newer');
      expect(reopened.checkpoints.some((c) => c.id === earlier.id)).toBe(true);
      await reopened.releaseWriter();
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }, 20000);
