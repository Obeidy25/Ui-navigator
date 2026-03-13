/**
 * server/routers.ts — Main tRPC router aggregation.
 */

import { router } from "./trpc.js";
import { sniperRouter } from "./routers/sniper.js";
import { chatRouter } from "./routers/chat.js";

export const appRouter = router({
  sniper: sniperRouter,
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;
