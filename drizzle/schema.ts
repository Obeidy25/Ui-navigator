import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

// ── Searches ────────────────────────────────────────────────────────
export const searches = sqliteTable("searches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default("default"),
  productName: text("product_name").notNull(),
  category: text("category").notNull().default("general"),
  maxPriceCents: integer("max_price_cents"),
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  geminiRecommendation: text("gemini_recommendation"),
  semanticAlternatives: text("semantic_alternatives", { mode: "json" }).$type<string[]>(),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── Search Results ──────────────────────────────────────────────────
export const searchResults = sqliteTable("search_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  searchId: integer("search_id")
    .notNull()
    .references(() => searches.id),
  productName: text("product_name").notNull(),
  priceCents: integer("price_cents").notNull(),
  originalPrice: text("original_price"),
  rating: real("rating"),
  reviewCount: integer("review_count"),
  source: text("source").notNull(), // amazon | ebay | walmart
  url: text("url"),
  imageUrl: text("image_url"),
  screenshotUrl: text("screenshot_url"),
  traceUrl: text("trace_url"),
  geminiAnalysis: text("gemini_analysis"),
  sentimentTags: text("sentiment_tags", { mode: "json" }).$type<string[]>(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── User Statistics ─────────────────────────────────────────────────
export const userStatistics = sqliteTable("user_statistics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().unique(),
  totalSearches: integer("total_searches").notNull().default(0),
  totalSavingsCents: integer("total_savings_cents").notNull().default(0),
  favoriteSite: text("favorite_site"),
  lastSearchAt: text("last_search_at"),
});

// ── Type Exports ────────────────────────────────────────────────────
export type Search = typeof searches.$inferSelect;
export type NewSearch = typeof searches.$inferInsert;
export type SearchResult = typeof searchResults.$inferSelect;
export type NewSearchResult = typeof searchResults.$inferInsert;
export type UserStat = typeof userStatistics.$inferSelect;
