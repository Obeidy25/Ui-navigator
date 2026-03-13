/**
 * server/routers/sniper.ts — tRPC router for Shopping Sniper procedures.
 *
 * 5 procedures:
 *  - search       (mutation) — Execute price comparison across 3 sites
 *  - getResults   (query)    — Retrieve results for a search
 *  - getHistory   (query)    — Get user's search history
 *  - getStats     (query)    — Get user statistics
 *  - rerunSearch  (mutation) — Re-execute a previous search
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  createSearch,
  updateSearchStatus,
  saveSearchResults,
  getSearchResults,
  getUserSearches,
  getUserStatistics,
  updateUserStatistics,
  getRecentExactSearch,
  clearUserSearches,
} from "../db.js";
import { searchAllSites, killAllRunningSearches } from "../phoenix_engine.js";
import {
  analyzeProducts,
  generateSemanticAlternatives,
  extractSentimentTags,
  cleanProductsWithAI,
  generatePreSearchQuestions,
  refineSearchQuery,
  type ProductData,
} from "../gemini_integration.js";

// ── Module Logger ───────────────────────────────────────────────────
const LOG_PREFIX = "[sniper-router]";
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${LOG_PREFIX} ${level}: ${msg}`);
}

// ── Input Schemas ───────────────────────────────────────────────────
const searchInput = z.object({
  productName: z.string().min(1).max(200),
  category: z
    .enum([
      "general",
      "electronics",
      "clothing",
      "home",
      "toys",
      "sports",
      "books",
      "auto",
      "grocery",
    ])
    .default("general"),
  maxPrice: z.number().positive().optional(),
});

const getResultsInput = z.object({
  searchId: z.number().positive(),
  sortBy: z.enum(["price", "rating", "source"]).default("price"),
});

const historyInput = z.object({
  limit: z.number().min(1).max(100).default(20),
});

const rerunInput = z.object({
  searchId: z.number().positive(),
});

// ── Router ──────────────────────────────────────────────────────────
export const sniperRouter = router({
  
  /**
   * generateQuestions — Ask Gemini to generate 3 targeted questions before searching.
   */
  generateQuestions: protectedProcedure
    .input(z.object({ productName: z.string(), category: z.string().default("general") }))
    .mutation(async ({ input }) => {
      log("INFO", `Generating Pre-Search Questions for: "${input.productName}"`);
      return await generatePreSearchQuestions(input.productName, input.category);
    }),

  /**
   * refineQuery — Combine original product name with user's answers into a highly optimized search string.
   */
  refineQuery: protectedProcedure
    .input(z.object({ productName: z.string(), answers: z.record(z.string()) }))
    .mutation(async ({ input }) => {
      log("INFO", `Refining query based on answers for: "${input.productName}"`);
      return await refineSearchQuery(input.productName, input.answers);
    }),

  /**
   * search — Execute a price comparison search across Amazon, eBay, Walmart.
   * Uses Promise.all() for concurrent site searches.
   */
  search: protectedProcedure.input(searchInput).mutation(async ({ input, ctx }) => {
    log("INFO", `Search initiated: "${input.productName}" [${input.category}]`);

    try {
      // 0. Smart Caching check
      const cachedSearch = await getRecentExactSearch(
        input.productName,
        input.category,
        12 // hours
      );

      if (cachedSearch) {
        log("INFO", `CACHE HIT! Returning results from search #${cachedSearch.id}`);
        const cachedResults = await getSearchResults(cachedSearch.id, "price");
        
        let recommendation = null;
        if (cachedSearch.geminiRecommendation) {
          try {
            recommendation = JSON.parse(cachedSearch.geminiRecommendation);
          } catch (e) {}
        }

        const savingsCents = recommendation?.savingsEstimateCents ?? 0;
        const bestSite = recommendation?.bestDeal
          ? cachedResults.find(
              (p) => p.productName.toLowerCase() === recommendation!.bestDeal.toLowerCase()
            )?.source
          : undefined;

        let alternatives: string[] = [];
        if (cachedSearch.semanticAlternatives) {
          try {
            alternatives = JSON.parse(String(cachedSearch.semanticAlternatives));
          } catch (e) {}
        }

        await updateUserStatistics(ctx.userId, savingsCents, bestSite);

        return {
          searchId: cachedSearch.id,
          products: cachedResults.map((p) => ({
            name: p.productName,
            priceCents: p.priceCents,
            rating: p.rating,
            reviewCount: p.reviewCount,
            source: p.source,
            url: p.url,
            imageUrl: p.imageUrl,
            screenshotUrl: p.screenshotUrl,
            priceDisplay: `$${(p.priceCents / 100).toFixed(2)}`,
            sentimentTags: p.sentimentTags,
            traceUrl: p.traceUrl,
          })),
          recommendation,
          alternatives,
          siteResults: [], // No fresh site results required
          isCached: true,
        };
      }

      // 1. Create new search record
      const search = await createSearch({
        productName: input.productName,
        category: input.category,
        maxPriceCents: input.maxPrice
          ? Math.round(input.maxPrice * 100)
          : undefined,
        userId: ctx.userId,
      });

      await updateSearchStatus(search.id, "running");

      // 2. Search all sites in parallel
      const siteResults = await searchAllSites(input.productName);

      // 3. Collect all products
      const allProducts: ProductData[] = [];
      const dbResults: any[] = [];

      for (const sr of siteResults) {
        for (const p of sr.products) {
          allProducts.push({
            name: p.name,
            priceCents: p.priceCents,
            rating: p.rating,
            reviewCount: p.reviewCount,
            source: sr.site,
            url: p.url,
          });

          dbResults.push({
            searchId: search.id,
            productName: p.name,
            priceCents: p.priceCents,
            originalPrice: p.originalPrice,
            rating: p.rating,
            reviewCount: p.reviewCount,
            source: sr.site.toLowerCase(),
            url: p.url,
            imageUrl: p.imageUrl,
            screenshotUrl: p.screenshotUrl ?? sr.screenshotUrl,
            traceUrl: sr.traceUrl,
          });
        }
      }

      // 5. AI Product Cleaning
      let dataQuality = { rawCount: allProducts.length, cleanedCount: allProducts.length };
      let cleanedProducts = allProducts;

      if (allProducts.length > 0) {
        try {
          const cleanResult = await cleanProductsWithAI(allProducts, input.productName);
          cleanedProducts = cleanResult.cleaned;
          dataQuality = { rawCount: cleanResult.rawCount, cleanedCount: cleanResult.cleanedCount };
        } catch (err) {
          log("WARNING", `AI cleaning failed, using raw: ${err}`);
        }
      }

      // 6. Get Gemini recommendation & advanced features
      let recommendation = null;
      let alternatives: string[] = [];

      if (cleanedProducts.length > 0) {
        try {
          // Determine average price for alternatives budget
          const avgPrice =
            cleanedProducts.reduce((sum, p) => sum + p.priceCents, 0) /
            cleanedProducts.length;

          // Run advanced AI tasks concurrently
          const [recResult, altResult] = await Promise.all([
            analyzeProducts(cleanedProducts, input.productName),
            generateSemanticAlternatives(input.productName, avgPrice),
          ]);
          recommendation = recResult;
          alternatives = altResult;

          // Process sentiment tags for top 15 products to save time/tokens
          const topProducts = dbResults.slice(0, 15);
          const sentimentPromises = topProducts.map((p) =>
            extractSentimentTags(p.productName).then((tags) => {
              p.sentimentTags = tags;
            })
          );
          await Promise.allSettled(sentimentPromises);
        } catch (err) {
          log("WARNING", `Gemini advanced analysis failed: ${err}`);
        }
      }

      // 4. Save results to database (MOVED HERE to include sentiment tags)
      if (dbResults.length > 0) {
        await saveSearchResults(dbResults);
      }

      // 6. Update search status
      const totalCostUsd = siteResults.reduce((sum, sr) => sum + (sr.costUsd || 0), 0);
      await updateSearchStatus(
        search.id,
        cleanedProducts.length > 0 ? "completed" : "failed",
        recommendation ? JSON.stringify(recommendation) : undefined,
        alternatives.length > 0 ? alternatives : undefined,
        totalCostUsd
      );

      // 8. Update user statistics
      const savingsCents = recommendation?.savingsEstimateCents ?? 0;
      const bestSite = recommendation?.bestDeal
        ? cleanedProducts.find(
            (p) =>
              p.name.toLowerCase() ===
              recommendation!.bestDeal.toLowerCase()
          )?.source
        : undefined;

      await updateUserStatistics(ctx.userId, savingsCents, bestSite);

      log(
        "INFO",
        `Search #${search.id} complete: ${cleanedProducts.length} products (from ${allProducts.length} raw), ` +
          `savings: $${(savingsCents / 100).toFixed(2)}`
      );

      return {
        searchId: search.id,
        products: cleanedProducts.map((p) => ({
          ...p,
          priceDisplay: `$${(p.priceCents / 100).toFixed(2)}`,
        })),
        recommendation,
        dataQuality,
        siteResults: siteResults.map((sr) => ({
          site: sr.site,
          productCount: sr.products.length,
          error: sr.error,
          durationMs: sr.durationMs,
          screenshotUrl: sr.screenshotUrl,
        })),
      };
    } catch (err: any) {
      log("ERROR", `Search failed: ${err.message}`);
      throw new Error(`Search failed: ${err.message}`);
    }
  }),

  /**
   * getResults — Retrieve sorted results for a specific search.
   */
  getResults: protectedProcedure
    .input(getResultsInput)
    .query(async ({ input }) => {
      try {
        const results = await getSearchResults(input.searchId, input.sortBy);
        return results.map((r) => ({
          ...r,
          priceDisplay: `$${(r.priceCents / 100).toFixed(2)}`,
        }));
      } catch (err: any) {
        log("ERROR", `getResults failed: ${err.message}`);
        return [];
      }
    }),

  /**
   * getHistory — Get user's search history.
   */
  getHistory: protectedProcedure
    .input(historyInput)
    .query(async ({ input, ctx }) => {
      try {
        return await getUserSearches(ctx.userId, input.limit);
      } catch (err: any) {
        log("ERROR", `getHistory failed: ${err.message}`);
        return [];
      }
    }),

  /**
   * clearHistory — Clear user's search history.
   */
  clearHistory: protectedProcedure
    .mutation(async ({ ctx }) => {
      try {
        // Stop any running searches before clearing history
        killAllRunningSearches();
        await clearUserSearches(ctx.userId);
        return { success: true };
      } catch (err: any) {
        log("ERROR", `clearHistory failed: ${err.message}`);
        throw new Error("Failed to clear history");
      }
    }),

  /**
   * abortSearch — Stop all currently running search processes.
   */
  abortSearch: protectedProcedure
    .mutation(async () => {
      try {
        killAllRunningSearches();
        return { success: true };
      } catch (err: any) {
        log("ERROR", `abortSearch failed: ${err.message}`);
        throw new Error("Failed to abort searches");
      }
    }),

  /**
   * getStats — Get user engagement statistics.
   */
  getStats: protectedProcedure.query(async ({ ctx }) => {
    try {
      const stats = await getUserStatistics(ctx.userId);
      return {
        ...stats,
        totalSavingsDisplay: `$${((stats.totalSavingsCents ?? 0) / 100).toFixed(2)}`,
      };
    } catch (err: any) {
      log("ERROR", `getStats failed: ${err.message}`);
      return {
        id: 0,
        userId: ctx.userId,
        totalSearches: 0,
        totalSavingsCents: 0,
        totalSavingsDisplay: "$0.00",
        favoriteSite: null,
        lastSearchAt: null,
      };
    }
  }),

  /**
   * rerunSearch — Re-execute a previous search by its ID.
   */
  rerunSearch: protectedProcedure
    .input(rerunInput)
    .mutation(async ({ input, ctx }) => {
      try {
        const searches = await getUserSearches(ctx.userId, 100);
        const original = searches.find((s) => s.id === input.searchId);

        if (!original) {
          throw new Error(`Search #${input.searchId} not found`);
        }

        log(
          "INFO",
          `Re-running search #${input.searchId}: "${original.productName}"`
        );

        // Create a new search record for the re-run
        const search = await createSearch({
          productName: original.productName,
          category: original.category,
          maxPriceCents: original.maxPriceCents ?? undefined,
          userId: ctx.userId,
        });

        await updateSearchStatus(search.id, "running");

        // Search all sites again
        const siteResults = await searchAllSites(original.productName);
        const totalCostUsd = siteResults.reduce((sum, sr) => sum + (sr.costUsd || 0), 0);
        const allProducts: ProductData[] = [];
        const dbResults: any[] = [];

        for (const sr of siteResults) {
          for (const p of sr.products) {
            allProducts.push({
              name: p.name,
              priceCents: p.priceCents,
              rating: p.rating,
              reviewCount: p.reviewCount,
              source: sr.site,
              url: p.url,
            });
            dbResults.push({
              searchId: search.id,
              productName: p.name,
              priceCents: p.priceCents,
              originalPrice: p.originalPrice,
              rating: p.rating,
              reviewCount: p.reviewCount,
              source: sr.site.toLowerCase(),
              url: p.url,
              imageUrl: p.imageUrl,
              screenshotUrl: p.screenshotUrl ?? sr.screenshotUrl,
              traceUrl: sr.traceUrl,
            });
          }
        }

        if (dbResults.length > 0) {
          await saveSearchResults(dbResults);
        }

        let recommendation = null;
        if (allProducts.length > 0) {
          try {
            recommendation = await analyzeProducts(
              allProducts,
              original.productName
            );
          } catch (err) {
            log("WARNING", `Gemini re-analysis failed: ${err}`);
          }
        }

        await updateSearchStatus(
          search.id,
          allProducts.length > 0 ? "completed" : "failed",
          recommendation ? JSON.stringify(recommendation) : undefined,
          undefined,
          totalCostUsd
        );

        return {
          searchId: search.id,
          products: allProducts.map((p) => ({
            ...p,
            priceDisplay: `$${(p.priceCents / 100).toFixed(2)}`,
          })),
          recommendation,
        };
      } catch (err: any) {
        log("ERROR", `rerunSearch failed: ${err.message}`);
        throw new Error(`Re-run failed: ${err.message}`);
      }
    }),
});

export type SniperRouter = typeof sniperRouter;
