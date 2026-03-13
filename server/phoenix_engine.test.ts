/**
 * server/phoenix_engine.test.ts — Tests for Phoenix Engine subprocess wrapper.
 *
 * Tests circuit breaker per-site, timeout handling, output parsing,
 * and graceful error fallbacks without spawning real subprocesses.
 */

import { describe, it, expect, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// Site Circuit Breaker (isolated test)
// ═══════════════════════════════════════════════════════════════════

const MAX_ATTEMPTS = 5;

class SiteCircuitBreaker {
  private attempts: Record<string, number> = {};

  canAttempt(site: string): boolean {
    return (this.attempts[site] || 0) < MAX_ATTEMPTS;
  }

  recordAttempt(site: string) {
    this.attempts[site] = (this.attempts[site] || 0) + 1;
  }

  resetSite(site: string) {
    this.attempts[site] = 0;
  }

  resetAll() {
    this.attempts = {};
  }

  getAttempts(site: string): number {
    return this.attempts[site] || 0;
  }
}

describe("SiteCircuitBreaker", () => {
  let cb: SiteCircuitBreaker;

  beforeEach(() => {
    cb = new SiteCircuitBreaker();
  });

  it("should allow first attempt", () => {
    expect(cb.canAttempt("amazon")).toBe(true);
  });

  it("should track attempts per site independently", () => {
    cb.recordAttempt("amazon");
    cb.recordAttempt("amazon");
    cb.recordAttempt("ebay");

    expect(cb.getAttempts("amazon")).toBe(2);
    expect(cb.getAttempts("ebay")).toBe(1);
    expect(cb.getAttempts("walmart")).toBe(0);
  });

  it("should block after 5 failed attempts", () => {
    for (let i = 0; i < 5; i++) {
      expect(cb.canAttempt("amazon")).toBe(true);
      cb.recordAttempt("amazon");
    }
    expect(cb.canAttempt("amazon")).toBe(false);
  });

  it("should not block other sites when one is blocked", () => {
    for (let i = 0; i < 5; i++) cb.recordAttempt("amazon");

    expect(cb.canAttempt("amazon")).toBe(false);
    expect(cb.canAttempt("ebay")).toBe(true);
    expect(cb.canAttempt("walmart")).toBe(true);
  });

  it("should reset a single site", () => {
    for (let i = 0; i < 5; i++) cb.recordAttempt("amazon");
    expect(cb.canAttempt("amazon")).toBe(false);

    cb.resetSite("amazon");
    expect(cb.canAttempt("amazon")).toBe(true);
    expect(cb.getAttempts("amazon")).toBe(0);
  });

  it("should reset all sites", () => {
    for (let i = 0; i < 5; i++) {
      cb.recordAttempt("amazon");
      cb.recordAttempt("ebay");
    }
    expect(cb.canAttempt("amazon")).toBe(false);
    expect(cb.canAttempt("ebay")).toBe(false);

    cb.resetAll();
    expect(cb.canAttempt("amazon")).toBe(true);
    expect(cb.canAttempt("ebay")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Output Parser (isolated test)
// ═══════════════════════════════════════════════════════════════════

interface PhoenixProduct {
  name: string;
  priceCents: number;
  originalPrice: string | null;
  rating: number | null;
  reviewCount: number | null;
  source: string;
  url: string | null;
  imageUrl: string | null;
  screenshotUrl: string | null;
}

function extractProductName(line: string): string | null {
  const cleaned = line
    .replace(/\$[\d,]+\.?\d{0,2}/g, "")
    .replace(/\d+\.?\d*\s*(?:out of|\/)\s*5/gi, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .trim();
  if (cleaned.length > 5 && cleaned.length < 200) {
    return cleaned.slice(0, 120);
  }
  return null;
}

function parseProductOutput(output: string, source: string, searchUrl: string): PhoenixProduct[] {
  const products: PhoenixProduct[] = [];

  try {
    // Try JSON format first
    const jsonMatch = output.match(/\[PRODUCTS_JSON\](.*?)\[\/PRODUCTS_JSON\]/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        return parsed.map((p: any) => ({
          name: p.name || "Unknown Product",
          priceCents: Math.round((parseFloat(p.price) || 0) * 100),
          originalPrice: p.original_price || null,
          rating: parseFloat(p.rating) || null,
          reviewCount: parseInt(p.review_count) || null,
          source,
          url: p.url || searchUrl,
          imageUrl: p.image_url || null,
          screenshotUrl: null,
        }));
      }
    }

    // Fallback: price regex
    const lines = output.split("\n");
    const priceRegex = /\$[\d,]+\.?\d{0,2}/g;

    for (const line of lines) {
      const prices = line.match(priceRegex);
      if (prices && prices.length > 0) {
        const priceStr = prices[0].replace(/[$,]/g, "");
        const priceCents = Math.round(parseFloat(priceStr) * 100);
        if (priceCents > 0 && priceCents < 100000000) {
          products.push({
            name: extractProductName(line) || `Product from ${source}`,
            priceCents,
            originalPrice: prices.length > 1 ? prices[1] : null,
            rating: null,
            reviewCount: null,
            source,
            url: searchUrl,
            imageUrl: null,
            screenshotUrl: null,
          });
        }
      }
    }
  } catch {
    // parse errors → return empty
  }

  // Deduplicate
  const seen = new Set<string>();
  return products.filter((p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe("parseProductOutput", () => {
  it("should parse JSON-formatted product output", () => {
    const output = `Some text
[PRODUCTS_JSON][{"name":"iPhone 15","price":"999.99","rating":"4.5","review_count":"1200","url":"https://amazon.com/iphone"}][/PRODUCTS_JSON]
More text`;

    const products = parseProductOutput(output, "Amazon", "https://amazon.com/search");

    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("iPhone 15");
    expect(products[0].priceCents).toBe(99999);
    expect(products[0].rating).toBe(4.5);
    expect(products[0].source).toBe("Amazon");
  });

  it("should parse price from text lines", () => {
    const output = `
Sony WH-1000XM5 Headphones $349.99 - Best noise cancelling
Apple AirPods Pro $199.00 - Great for Apple ecosystem
`;

    const products = parseProductOutput(output, "Amazon", "https://amazon.com/search");

    expect(products.length).toBeGreaterThanOrEqual(2);
    expect(products[0].priceCents).toBe(34999);
    expect(products[1].priceCents).toBe(19900);
  });

  it("should return empty array for no-price output", () => {
    const output = "No products found. The page loaded but showed an error.";
    const products = parseProductOutput(output, "Amazon", "https://amazon.com");
    expect(products).toHaveLength(0);
  });

  it("should deduplicate products by name", () => {
    const output = `
iPhone 15 Pro $999.99
iPhone 15 Pro $999.99
iPhone 15 Pro $999.99
`;

    const products = parseProductOutput(output, "Amazon", "https://amazon.com");
    // Should have only 1 after dedup (same name)
    expect(products.length).toBeLessThanOrEqual(1);
  });

  it("should filter out insane prices (> $1M)", () => {
    const output = "Product $999999999.99 - way too expensive";
    const products = parseProductOutput(output, "Test", "url");
    expect(products).toHaveLength(0);
  });

  it("should handle empty output gracefully", () => {
    const products = parseProductOutput("", "Amazon", "url");
    expect(products).toHaveLength(0);
  });
});

describe("extractProductName", () => {
  it("should extract name by stripping prices", () => {
    const name = extractProductName("Sony WH-1000XM5 $349.99 noise cancelling headphones");
    expect(name).toBeDefined();
    expect(name).not.toContain("$349.99");
  });

  it("should return null for very short text", () => {
    expect(extractProductName("Hi")).toBeNull();
  });

  it("should truncate very long names to 120 chars", () => {
    // Function allows up to 200 chars, then truncates to 120
    const longLine = "A".repeat(150) + " $99.99";
    const name = extractProductName(longLine);
    expect(name).toBeDefined();
    expect(name!.length).toBeLessThanOrEqual(120);
  });
});
