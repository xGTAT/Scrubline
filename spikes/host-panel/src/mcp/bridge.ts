import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export interface McpBackend {
  list: () => Promise<unknown>;
  review: (checkpoint: string) => Promise<unknown>;
}
export class McpBridge {
  private server?: Server;
  private token = randomBytes(32).toString('hex');
  constructor(
    readonly root: string,
    readonly backend: McpBackend
  ) {}
  async start() {
    await this.stop();
    this.token = randomBytes(32).toString('hex');
    this.server = createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + this.token);
      if (
        req.headers.origin ||
        auth.length !== expected.length ||
        !timingSafeEqual(auth, expected)
      ) {
        res.writeHead(403).end();
        return;
      }
      const address = this.server?.address();
      if (
        !address ||
        typeof address === 'string' ||
        req.headers.host !== `127.0.0.1:${address.port}`
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== 'POST' || req.url !== '/tool') {
        res.writeHead(404).end();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        let result: unknown;
        if (body.name === 'list_checkpoints') result = await this.backend.list();
        else if (body.name === 'restore_checkpoint' && /^[a-f0-9]{64}$/.test(body.checkpoint ?? ''))
          result = await this.backend.review(body.checkpoint);
        else {
          res.writeHead(400).end();
          return;
        }
        res
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify(result));
      } catch {
        res
          .writeHead(400)
          .end(JSON.stringify({ error: 'Request refused. Check Scrubline panel.' }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Local bridge unavailable.');
    await fs.mkdir(this.root, { recursive: true });
    const file = path.join(this.root, 'mcp-connection.json');
    await fs.writeFile(
      file,
      JSON.stringify({ url: `http://127.0.0.1:${address.port}/tool`, token: this.token }),
      { mode: 0o600 }
    );
    return file;
  }
  async stop() {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    await fs.rm(path.join(this.root, 'mcp-connection.json'), { force: true });
  }
}
