/**
 * server/trpc.ts — tRPC initialization and context creation.
 */

import { initTRPC } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import superjson from "superjson";

// ── Context ─────────────────────────────────────────────────────────
export async function createContext({ req, res }: CreateExpressContextOptions) {
  // For now, use a default user. In production: extract from auth header.
  const userId = (req.headers["x-user-id"] as string) || "default";
  return { userId, req, res };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

// ── tRPC Instance ───────────────────────────────────────────────────
const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure; // In production: add auth middleware
