import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ReplayEngine {
  constructor() {
    this.activeFixture = null;

    this.server = http.createServer(async (req, res) => {
      // Allow CORS for proxy tests
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      if (req.method !== 'POST') {
        res.writeHead(200);
        return res.end();
      }

      if (!this.activeFixture) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'No active fixture loaded.' }));
      }

      // Consume the request body to avoid hanging the connection
      for await (const chunk of req) {}

      console.log(`[ReplayEngine] Replaying fixture: ${this.activeFixture.name}`);
      const events = this.activeFixture.events;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.flushHeaders();

      for (const evt of events) {
        if (evt.delayMs) {
          await new Promise(r => setTimeout(r, evt.delayMs));
        }
        if (evt.action === 'disconnect') {
          console.log(`[ReplayEngine] Simulating unexpected disconnect.`);
          res.destroy();
          return;
        } else if (evt.chunk) {
          res.write(evt.chunk);
        }
      }
      
      res.end();
    });
  }

  async loadFixture(fixtureName) {
    const fixturePath = path.join(__dirname, 'fixtures', `${fixtureName}.json`);
    const content = await fs.readFile(fixturePath, 'utf-8');
    this.activeFixture = JSON.parse(content);
    return this.activeFixture;
  }

  async start(port = 2024) {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        console.log(`[ReplayEngine] Listening on http://127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log(`[ReplayEngine] Server stopped.`);
        resolve();
      });
    });
  }
}
