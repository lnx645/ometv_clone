/**
 * Local development entry point.
 *
 * Vercel imports server/app.ts through api/ws.ts; this file exists so
 * `bun --watch server/dev.ts` runs a plain HTTP + WebSocket server on :8787.
 */
import { app } from './app.ts';

const port = Number(process.env.PORT ?? 8787);

export default {
  port,
  fetch: app.fetch,
  websocket: app.websocket,
};