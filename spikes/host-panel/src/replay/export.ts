import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Checkpoint } from '../bridge/timeline';
export interface ReplayFrame {
  png: Buffer;
  identity: string;
}
export interface ReplayMetadata {
  version: 1;
  privacy: 'masked-layout';
  frames: { image: string; identity: string; number: number }[];
}
export async function exportReplay(
  destination: string,
  checkpoints: readonly Checkpoint[],
  render: (checkpoint: Checkpoint) => Promise<ReplayFrame>
) {
  if (!checkpoints.length) throw new Error('Capture a checkpoint first.');
  if (checkpoints.length > 200) throw new Error('Export at most 200 checkpoints.');
  // Exclusive new folder. Never overwrite an existing export or project.
  const directory = path.join(destination, `scrubline-replay-${randomUUID()}`);
  await fs.mkdir(directory);
  try {
    await fs.mkdir(path.join(directory, 'frames'));
    const metadata: ReplayMetadata = { version: 1, privacy: 'masked-layout', frames: [] };
    let total = 0;
    for (let i = 0; i < checkpoints.length; i++) {
      const frame = await render(checkpoints[i]);
      if (
        !Buffer.isBuffer(frame.png) ||
        !frame.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error('Invalid replay image.');
      total += frame.png.length;
      if (total > 50 * 1024 * 1024) throw new Error('Replay exceeds 50 MB.');
      const image = `frames/${i + 1}.png`;
      await fs.writeFile(path.join(directory, image), frame.png, { flag: 'wx' });
      metadata.frames.push({
        image,
        identity: createHash('sha256').update(frame.identity).digest('hex'),
        number: i + 1
      });
    }
    await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));
    await fs.writeFile(path.join(directory, 'index.html'), replayPage(metadata));
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}
export function replayPage(metadata: ReplayMetadata) {
  const data = JSON.stringify(metadata).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Scrubline replay</title><style>
:root{color-scheme:dark;font-family:Geist,Inter,system-ui,sans-serif;background:#101113;color:#f0f1f2}*{box-sizing:border-box}body{margin:0;padding:clamp(16px,4vw,52px)}main{max-width:1056px;margin:auto}header,nav{display:flex;align-items:center;justify-content:space-between;gap:12px}header{margin-bottom:24px}h1{font-size:24px;letter-spacing:-.7px;margin:0}small{color:#989da6}figure{margin:0;background:#181b20;border:1px solid #30343d;border-radius:16px;overflow:hidden}img{display:block;width:100%;aspect-ratio:8/5;object-fit:contain}figcaption{padding:12px 20px;color:#b4bac5;font-size:13px}nav{margin-top:18px}button{background:#23272f;color:inherit;border:1px solid #3b414c;border-radius:8px;padding:10px 16px;font:inherit}button:focus-visible,input:focus-visible{outline:2px solid #95b7ff;outline-offset:3px}button:disabled{opacity:.4}input{flex:1;min-width:40px;accent-color:#a2bfff}.same{animation:fade .18s ease-out}@keyframes fade{from{opacity:.55}to{opacity:1}}@media(prefers-reduced-motion:reduce){.same{animation:none}}@media(max-width:480px){header{align-items:start;flex-direction:column}button{padding:9px}h1{font-size:21px}}
</style></head><body><main><header><h1>Scrubline replay</h1><small>Local only · Masked layout</small></header><figure><img id="frame" alt="Masked historical layout"><figcaption id="caption" aria-live="polite"></figcaption></figure><nav aria-label="Playback"><button id="prev">Prev</button><button id="play">Play</button><input id="seek" aria-label="Checkpoint" type="range" min="0" max="${metadata.frames.length - 1}" value="0"><button id="next">Next</button></nav></main><script>
const data=${data};let index=0,timer;const frame=document.getElementById('frame'),seek=document.getElementById('seek'),caption=document.getElementById('caption'),prev=document.getElementById('prev'),next=document.getElementById('next'),play=document.getElementById('play');
function show(n){const old=data.frames[index];index=Math.max(0,Math.min(data.frames.length-1,n));const f=data.frames[index];frame.classList.remove('same');frame.src=f.image;if(old.identity===f.identity&&!matchMedia('(prefers-reduced-motion:reduce)').matches)frame.onload=()=>frame.classList.add('same');else frame.onload=null;caption.textContent='Checkpoint '+(index+1)+' of '+data.frames.length+' · Text and media hidden';seek.value=index;seek.setAttribute('aria-valuetext',caption.textContent);prev.disabled=index===0;next.disabled=index===data.frames.length-1;}
function stop(){clearInterval(timer);timer=undefined;play.textContent='Play'}prev.onclick=()=>{stop();show(index-1)};next.onclick=()=>{stop();show(index+1)};seek.oninput=()=>{stop();show(Number(seek.value))};play.onclick=()=>{if(timer){stop();return}if(index===data.frames.length-1)show(0);play.textContent='Pause';timer=setInterval(()=>{if(index===data.frames.length-1){stop();return}show(index+1)},1500)};document.addEventListener('visibilitychange',()=>{if(document.hidden)stop()});show(0);
</script></body></html>`;
}

// Local replay export ends here.
