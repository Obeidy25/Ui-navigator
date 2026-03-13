/**
 * server/db.ts — Database connection + CRUD helpers using Drizzle ORM.
 *
 * All prices are stored/returned in CENTS (integer).
 * All timestamps are UTC ISO strings.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, desc, sql } from "drizzle-orm";
import {
  searches,
  searchResults,
  userStatistics,
  type NewSearch,
  type NewSearchResult,
} from "../drizzle/schema.js";

// ── Module Logger ───────────────────────────────────────────────────
const LOG_PREFIX = "[db]";
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${LOG_PREFIX} ${level}: ${msg}`);
}

// ── Connection ──────────────────────────────────────────────────────
const sqlite = new Database("./sniper.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

// ── Ensure tables exist (auto-create if missing) ────────────────────
function ensureTables() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      product_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      max_price_cents INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      gemini_recommendation TEXT,
      semantic_alternatives TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS search_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL REFERENCES searches(id),
      product_name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      original_price TEXT,
      rating REAL,
      review_count INTEGER,
      source TEXT NOT NULL,
      url TEXT,
      image_url TEXT,
      screenshot_url TEXT,
      trace_url TEXT,
      gemini_analysis TEXT,
      sentiment_tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_statistics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      total_searches INTEGER NOT NULL DEFAULT 0,
      total_savings_cents INTEGER NOT NULL DEFAULT 0,
      favorite_site TEXT,
      last_search_at TEXT
    );
  `);

  // Migrations for existing database
  try {
    sqlite.exec(`ALTER TABLE searches ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;`);
    log("INFO", "Added cost_usd column to searches table");
  } catch (err) {
    // Column already exists
  }

  try {
    sqlite.exec(`ALTER TABLE search_results ADD COLUMN trace_url TEXT;`);
    log("INFO", "Added trace_url column to search_results table");
  } catch (err) {
    // Column already exists
  }

  log("INFO", "Tables ensured");
}

ensureTables();

// ── CRUD Helpers ────────────────────────────────────────────────────

/** Insert a new search record. Returns the created search. */
export async function createSearch(data: {
  productName: string;
  category?: string;
  maxPriceCents?: number;
  userId?: string;
}) {
  try {
    const result = db
      .insert(searches)
      .values({
        productName: data.productName,
        category: data.category ?? "general",
        maxPriceCents: data.maxPriceCents,
        userId: data.userId ?? "default",
        status: "pending",
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
    log("INFO", `Created search #${result.id}: "${data.productName}"`);
    return result;
  } catch (err) {
    log("ERROR", `createSearch failed: ${err}`);
    throw err;
  }
}

/** Update search status and optional recommendation. */
export async function updateSearchStatus(
  searchId: number,
  status: string,
  recommendation?: string,
  alternatives?: string[],
  costUsd?: number
) {
  try {
    db.update(searches)
      .set({
        status,
        ...(recommendation ? { geminiRecommendation: recommendation } : {}),
        ...(alternatives ? { semanticAlternatives: alternatives } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      })
      .where(eq(searches.id, searchId))
      .run();
    log("INFO", `Updated search #${searchId} → ${status}`);
  } catch (err) {
    log("ERROR", `updateSearchStatus failed: ${err}`);
  }
}

/** Batch insert product results for a search. */
export async function saveSearchResults(results: NewSearchResult[]) {
  if (results.length === 0) return [];
  try {
    const inserted = db
      .insert(searchResults)
      .values(
        results.map((r) => ({
          ...r,
          createdAt: new Date().toISOString(),
        }))
      )
      .returning()
      .all();
    log("INFO", `Saved ${inserted.length} results for search #${results[0].searchId}`);
    return inserted;
  } catch (err) {
    log("ERROR", `saveSearchResults failed: ${err}`);
    throw err;
  }
}

/** Retrieve results for a search, optionally sorted. */
export async function getSearchResults(
  searchId: number,
  sortBy: "price" | "rating" | "source" = "price"
) {
  try {
    const orderCol =
      sortBy === "price"
        ? searchResults.priceCents
        : sortBy === "rating"
          ? searchResults.rating
          : searchResults.source;

    const results = db
      .select()
      .from(searchResults)
      .where(eq(searchResults.searchId, searchId))
      .orderBy(sortBy === "rating" ? desc(orderCol) : orderCol)
      .all();

    return results;
  } catch (err) {
    log("ERROR", `getSearchResults failed: ${err}`);
    return [];
  }
}

/** Get a recent exact match search from within the last 12 hours. */
export async function getRecentExactSearch(
  productName: string,
  category: string,
  hours = 12
) {
  try {
    const timeLimit = new Date();
    timeLimit.setHours(timeLimit.getHours() - hours);
    const limitIsostring = timeLimit.toISOString();

    const recentSearch = db
      .select()
      .from(searches)
      .where(sql`
        lower(${searches.productName}) = lower(${productName})
        AND ${searches.category} = ${category}
        AND ${searches.status} = 'completed'
        AND ${searches.createdAt} >= ${limitIsostring}
      `)
      .orderBy(desc(searches.createdAt))
      .get();
      
    return recentSearch;
  } catch (err) {
    log("ERROR", `getRecentExactSearch failed: ${err}`);
    return undefined;
  }
}

/** Get search history for a user. */
export async function getUserSearches(userId: string = "default", limit = 20) {
  try {
    return db
      .select()
      .from(searches)
      .where(eq(searches.userId, userId))
      .orderBy(desc(searches.createdAt))
      .limit(limit)
      .all();
  } catch (err) {
    log("ERROR", `getUserSearches failed: ${err}`);
    return [];
  }
}

/** Get or create user statistics. */
export async function getUserStatistics(userId: string = "default") {
  try {
    let stats = db
      .select()
      .from(userStatistics)
      .where(eq(userStatistics.userId, userId))
      .get();

    if (!stats) {
      stats = db
        .insert(userStatistics)
        .values({ userId, totalSearches: 0, totalSavingsCents: 0 })
        .returning()
        .get();
    }
    return stats;
  } catch (err) {
    log("ERROR", `getUserStatistics failed: ${err}`);
    return {
      id: 0,
      userId,
      totalSearches: 0,
      totalSavingsCents: 0,
      favoriteSite: null,
      lastSearchAt: null,
    };
  }
}

/** Update user statistics after a search. */
export async function updateUserStatistics(
  userId: string = "default",
  savingsCents: number = 0,
  site?: string
) {
  try {
    const existing = await getUserStatistics(userId);

    db.update(userStatistics)
      .set({
        totalSearches: existing.totalSearches + 1,
        totalSavingsCents: existing.totalSavingsCents + savingsCents,
        favoriteSite: site ?? existing.favoriteSite,
        lastSearchAt: new Date().toISOString(),
      })
      .where(eq(userStatistics.userId, userId))
      .run();

    log("INFO", `Updated stats for user "${userId}"`);
  } catch (err) {
    log("ERROR", `updateUserStatistics failed: ${err}`);
  }
}
