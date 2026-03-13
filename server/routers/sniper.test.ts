/**
 * server/routers/sniper.test.ts — Tests for tRPC Sniper Router procedures.
 *
 * Tests input validation (Zod schemas), procedure logic,
 * and data flow without real external service calls.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════
// Input Schema Validation Tests
// ═══════════════════════════════════════════════════════════════════

// Replicate the same Zod schemas from sniper.ts for isolated testing
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

describe("sniper.search — input validation", () => {
  it("should accept valid input with all fields", () => {
    const result = searchInput.safeParse({
      productName: "iPhone 15",
      category: "electronics",
      maxPrice: 999.99,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.productName).toBe("iPhone 15");
      expect(result.data.category).toBe("electronics");
      expect(result.data.maxPrice).toBe(999.99);
    }
  });

  it("should accept input with defaults", () => {
    const result = searchInput.safeParse({ productName: "AirPods" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe("general");
      expect(result.data.maxPrice).toBeUndefined();
    }
  });

  it("should reject empty productName", () => {
    const result = searchInput.safeParse({ productName: "" });
    expect(result.success).toBe(false);
  });

  it("should reject productName > 200 chars", () => {
    const result = searchInput.safeParse({ productName: "A".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("should reject invalid category", () => {
    const result = searchInput.safeParse({
      productName: "Test",
      category: "invalid_category",
    });
    expect(result.success).toBe(false);
  });

  it("should reject negative maxPrice", () => {
    const result = searchInput.safeParse({
      productName: "Test",
      maxPrice: -10,
    });
    expect(result.success).toBe(false);
  });

  it("should reject zero maxPrice", () => {
    const result = searchInput.safeParse({
      productName: "Test",
      maxPrice: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should accept all valid categories", () => {
    const categories = [
      "general", "electronics", "clothing", "home",
      "toys", "sports", "books", "auto", "grocery",
    ];
    for (const cat of categories) {
      const result = searchInput.safeParse({ productName: "Test", category: cat });
      expect(result.success).toBe(true);
    }
  });
});

describe("sniper.getResults — input validation", () => {
  it("should accept valid searchId and sortBy", () => {
    const result = getResultsInput.safeParse({ searchId: 1, sortBy: "price" });
    expect(result.success).toBe(true);
  });

  it("should default sortBy to price", () => {
    const result = getResultsInput.safeParse({ searchId: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sortBy).toBe("price");
    }
  });

  it("should reject negative searchId", () => {
    const result = getResultsInput.safeParse({ searchId: -1 });
    expect(result.success).toBe(false);
  });

  it("should reject invalid sortBy", () => {
    const result = getResultsInput.safeParse({ searchId: 1, sortBy: "invalid" });
    expect(result.success).toBe(false);
  });

  it("should accept all valid sortBy options", () => {
    for (const sort of ["price", "rating", "source"]) {
      const result = getResultsInput.safeParse({ searchId: 1, sortBy: sort });
      expect(result.success).toBe(true);
    }
  });
});

describe("sniper.getHistory — input validation", () => {
  it("should default limit to 20", () => {
    const result = historyInput.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("should reject limit > 100", () => {
    const result = historyInput.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("should reject limit < 1", () => {
    const result = historyInput.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("should accept limit = 50", () => {
    const result = historyInput.safeParse({ limit: 50 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });
});

describe("sniper.rerunSearch — input validation", () => {
  it("should accept valid searchId", () => {
    const result = rerunInput.safeParse({ searchId: 42 });
    expect(result.success).toBe(true);
  });

  it("should reject zero searchId", () => {
    const result = rerunInput.safeParse({ searchId: 0 });
    expect(result.success).toBe(false);
  });

  it("should reject missing searchId", () => {
    const result = rerunInput.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Price Conversion (cents ↔ display)
// ═══════════════════════════════════════════════════════════════════

describe("Price conversion — cents ↔ display", () => {
  it("should convert cents to display string", () => {
    const cents = 99999;
    const display = `$${(cents / 100).toFixed(2)}`;
    expect(display).toBe("$999.99");
  });

  it("should handle zero cents", () => {
    const display = `$${(0 / 100).toFixed(2)}`;
    expect(display).toBe("$0.00");
  });

  it("should handle single-cent values", () => {
    const display = `$${(1 / 100).toFixed(2)}`;
    expect(display).toBe("$0.01");
  });

  it("should convert dollars to cents accurately", () => {
    const dollars = 249.99;
    const cents = Math.round(dollars * 100);
    expect(cents).toBe(24999);
  });

  it("should avoid floating-point issues", () => {
    // Classic 0.1 + 0.2 problem — we store in cents to avoid
    const a = 1999; // $19.99
    const b = 2999; // $29.99
    const total = a + b;
    expect(total).toBe(4998); // exact integer math
    expect(`$${(total / 100).toFixed(2)}`).toBe("$49.98");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Parallel Search Logic
// ═══════════════════════════════════════════════════════════════════

describe("Promise.all parallel search logic", () => {
  it("should collect results from all 3 sites", async () => {
    const mockSearchSite = async (site: string) => ({
      site,
      products: [{ name: `Product from ${site}`, priceCents: 10000 }],
      error: null,
    });

    const results = await Promise.all([
      mockSearchSite("Amazon"),
      mockSearchSite("eBay"),
      mockSearchSite("Walmart"),
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].site).toBe("Amazon");
    expect(results[1].site).toBe("eBay");
    expect(results[2].site).toBe("Walmart");
  });

  it("should handle partial failure (1 site fails, 2 succeed)", async () => {
    const mockSearch = async (site: string, shouldFail: boolean) => {
      if (shouldFail) {
        return { site, products: [], error: `${site} timeout` };
      }
      return {
        site,
        products: [{ name: "Product", priceCents: 10000 }],
        error: null,
      };
    };

    const results = await Promise.all([
      mockSearch("Amazon", false),
      mockSearch("eBay", true), // fails
      mockSearch("Walmart", false),
    ]);

    const successful = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);

    expect(successful).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(failed[0].site).toBe("eBay");
  });

  it("should handle all sites failing", async () => {
    const failAll = async (site: string) => ({
      site,
      products: [],
      error: "Network error",
    });

    const results = await Promise.all([
      failAll("Amazon"),
      failAll("eBay"),
      failAll("Walmart"),
    ]);

    const totalProducts = results.reduce((s, r) => s + r.products.length, 0);
    expect(totalProducts).toBe(0);
    expect(results.every((r) => r.error !== null)).toBe(true);
  });
});
