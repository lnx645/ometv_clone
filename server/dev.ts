/**
 * Local development entry point.
 *
 * Vercel imports server/app.ts through api/ws.ts; this file exists so
 * `bun --watch server/dev.ts` runs a plain HTTP + WebSocket server on :8787.
 */
import { app, websocket } from './app.ts';

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch,
  websocket,
};