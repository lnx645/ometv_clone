/**
 * Vercel Function entry for the signaling server.
 *
 * Vercel routes `api/ws.ts` to /api/ws and upgrades that path to a WebSocket.
 * `websocket` is Bun's dispatch table for accepted connections.
 */
import { app, websocket } from '../server/app.ts';

export const config = { maxDuration: 300 };

export default {
  fetch: app.fetch,
  websocket,
};