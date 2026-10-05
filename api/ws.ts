/**
 * Vercel Function entry for the signaling server.
 *
 * Vercel routes `api/ws.ts` to /api/ws and upgrades that path to a WebSocket.
 * `app.websocket` is the handler map Hono builds from upgradeWebSocket().
 */
import { app } from '../server/app.ts';

export const config = { maxDuration: 300 };

export default {
  fetch: app.fetch,
  websocket: app.websocket,
};