/**
 * server/index.ts — Express server with tRPC middleware.
 *
 * Serves the tRPC API at /api/trpc and static screenshots.
 */

import express from "express";
import cors from "cors";
import path from "path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import dotenv from "dotenv";
import { appRouter } from "./routers.js";
import { createContext } from "./trpc.js";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ── Middleware ───────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// ── Static Screenshots ──────────────────────────────────────────────
app.use(
  "/api/screenshots",
  express.static(path.resolve("runs/screenshots"))
);

// ── tRPC ────────────────────────────────────────────────────────────
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext,
    onError({ error, path: procedurePath }) {
      console.error(
        `[trpc] Error in ${procedurePath}:`,
        error.message
      );
    },
  })
);

// ── Health Check ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "phoenix-shopping-sniper",
  });
});

// ── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Phoenix Shopping Sniper — API Server              ║");
  console.log(`║   Running on http://localhost:${PORT}                   ║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  tRPC endpoint: http://localhost:${PORT}/api/trpc`);
  console.log(`  Health check:  http://localhost:${PORT}/api/health`);
  console.log("");
});
