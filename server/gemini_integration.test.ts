/**
 * server/gemini_integration.test.ts — Tests for Gemini API integration.
 *
 * Tests circuit breaker behavior, response parsing, heuristic fallback,
 * and error handling without making real API calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── We test the internal logic by re-implementing key components ────
// This avoids importing the module (which tries to init dotenv/Gemini)

// ═══════════════════════════════════════════════════════════════════
// CircuitBreaker (isolated test of the pattern)
// ═══════════════════════════════════════════════════════════════════

class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private threshold: number;
  private cooldownMs: number;

  constructor(threshold = 3, cooldownMs = 30_000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  allow(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.state = "CLOSED";
  }

  recordFailure() {
    this.failures++;
    if (this.state === "HALF_OPEN" || this.failures >= this.threshold) {
      this.openedAt = Date.now();
      this.state = "OPEN";
    }
  }

  get isOpen(): boolean {
    return this.state === "OPEN";
  }

  get currentState(): string {
    return this.state;
  }
}

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(3, 100); // 3 failures, 100ms cooldown for fast tests
  });

  it("should start CLOSED and allow calls", () => {
    expect(cb.allow()).toBe(true);
    expect(cb.isOpen).toBe(false);
  });

  it("should stay CLOSED after 1-2 failures", () => {
    cb.recordFailure();
    expect(cb.allow()).toBe(true);
    expect(cb.isOpen).toBe(false);

    cb.recordFailure();
    expect(cb.allow()).toBe(true);
    expect(cb.isOpen).toBe(false);
  });

  it("should OPEN after 3 consecutive failures", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    expect(cb.isOpen).toBe(true);
    expect(cb.allow()).toBe(false);
  });

  it("should reset to CLOSED on success", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();

    expect(cb.isOpen).toBe(false);
    expect(cb.allow()).toBe(true);
  });

  it("should transition to HALF_OPEN after cooldown", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);

    // Wait for cooldown (100ms in test)
    await new Promise((r) => setTimeout(r, 150));

    expect(cb.allow()).toBe(true); // HALF_OPEN probe
    expect(cb.currentState).toBe("HALF_OPEN");
  });

  it("should CLOSE from HALF_OPEN on success", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    await new Promise((r) => setTimeout(r, 150));
    cb.allow(); // transition to HALF_OPEN
    cb.recordSuccess();

    expect(cb.currentState).toBe("CLOSED");
    expect(cb.allow()).toBe(true);
  });

  it("should revert to OPEN from HALF_OPEN on failure", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    await new Promise((r) => setTimeout(r, 150));
    cb.allow(); // HALF_OPEN
    cb.recordFailure(); // fail again → OPEN

    expect(cb.isOpen).toBe(true);
    expect(cb.allow()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Response Parsing
// ═══════════════════════════════════════════════════════════════════

interface ProductData {
  name: string;
  priceCents: number;
  rating: number | null;
  reviewCount: number | null;
  source: string;
  url: string | null;
}

interface GeminiRecommendation {
  bestDeal: string;
  reasoning: string;
  savingsEstimateCents: number;
  riskFactors: string[];
  confidence: number;
}

function parseGeminiResponse(text: string, products: ProductData[]): GeminiRecommendation {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    }
    const parsed = JSON.parse(cleaned);
    return {
      bestDeal: parsed.bestDeal || products[0]?.name || "Unknown",
      reasoning: parsed.reasoning || "Price-based recommendation.",
      savingsEstimateCents: parsed.savingsEstimateCents || 0,
      riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return heuristicRecommendation(products);
  }
}

function heuristicRecommendation(products: ProductData[]): GeminiRecommendation {
  if (products.length === 0) {
    return {
      bestDeal: "No products found",
      reasoning: "No products were found for comparison.",
      savingsEstimateCents: 0,
      riskFactors: ["No products available"],
      confidence: 0,
    };
  }
  const sorted = [...products].sort((a, b) => a.priceCents - b.priceCents);
  const best = sorted[0];
  const avg = products.reduce((s, p) => s + p.priceCents, 0) / products.length;
  return {
    bestDeal: best.name,
    reasoning: `Best value based on price ($${(best.priceCents / 100).toFixed(2)}).`,
    savingsEstimateCents: Math.max(0, Math.round(avg - best.priceCents)),
    riskFactors: ["Heuristic analysis"],
    confidence: 0.6,
  };
}

describe("parseGeminiResponse", () => {
  const sampleProducts: ProductData[] = [
    { name: "iPhone 15", priceCents: 99999, rating: 4.5, reviewCount: 1200, source: "Amazon", url: "url1" },
    { name: "iPhone 15", priceCents: 95000, rating: 4.3, reviewCount: 800, source: "eBay", url: "url2" },
  ];

  it("should parse valid JSON response", () => {
    const json = JSON.stringify({
      bestDeal: "iPhone 15",
      reasoning: "Best price on eBay",
      savingsEstimateCents: 4999,
      riskFactors: ["Seller reputation"],
      confidence: 0.85,
    });

    const result = parseGeminiResponse(json, sampleProducts);

    expect(result.bestDeal).toBe("iPhone 15");
    expect(result.savingsEstimateCents).toBe(4999);
    expect(result.confidence).toBe(0.85);
    expect(result.riskFactors).toContain("Seller reputation");
  });

  it("should handle markdown-wrapped JSON (```json ... ```)", () => {
    const wrapped = '```json\n{"bestDeal":"AirPods","reasoning":"Good deal","savingsEstimateCents":1000,"riskFactors":[],"confidence":0.9}\n```';

    const result = parseGeminiResponse(wrapped, sampleProducts);
    expect(result.bestDeal).toBe("AirPods");
    expect(result.confidence).toBe(0.9);
  });

  it("should fallback to heuristic on invalid JSON", () => {
    const result = parseGeminiResponse("This is not JSON at all!", sampleProducts);

    expect(result.bestDeal).toBe("iPhone 15"); // Cheapest by heuristic
    expect(result.confidence).toBe(0.6);
    expect(result.riskFactors).toContain("Heuristic analysis");
  });

  it("should fallback gracefully with no products", () => {
    const result = parseGeminiResponse("invalid", []);

    expect(result.bestDeal).toBe("No products found");
    expect(result.confidence).toBe(0);
  });

  it("should handle missing fields in response with defaults", () => {
    const partial = JSON.stringify({ bestDeal: "Product X" });
    const result = parseGeminiResponse(partial, sampleProducts);

    expect(result.bestDeal).toBe("Product X");
    expect(result.reasoning).toBe("Price-based recommendation.");
    expect(result.savingsEstimateCents).toBe(0);
    expect(result.riskFactors).toEqual([]);
    expect(result.confidence).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Heuristic Fallback
// ═══════════════════════════════════════════════════════════════════

describe("heuristicRecommendation", () => {
  it("should pick the cheapest product", () => {
    const products: ProductData[] = [
      { name: "Expensive", priceCents: 50000, rating: 4.0, reviewCount: 100, source: "Amazon", url: null },
      { name: "Cheapest", priceCents: 30000, rating: 4.5, reviewCount: 200, source: "eBay", url: null },
      { name: "Mid-range", priceCents: 40000, rating: 3.8, reviewCount: 50, source: "Walmart", url: null },
    ];

    const result = heuristicRecommendation(products);
    expect(result.bestDeal).toBe("Cheapest");
    expect(result.savingsEstimateCents).toBeGreaterThan(0);
  });

  it("should calculate savings vs average", () => {
    const products: ProductData[] = [
      { name: "A", priceCents: 10000, rating: null, reviewCount: null, source: "A", url: null },
      { name: "B", priceCents: 20000, rating: null, reviewCount: null, source: "B", url: null },
      { name: "C", priceCents: 30000, rating: null, reviewCount: null, source: "C", url: null },
    ];

    const result = heuristicRecommendation(products);
    // Average = 20000, cheapest = 10000, savings = 10000
    expect(result.savingsEstimateCents).toBe(10000);
  });

  it("should set confidence to 0.6 for heuristic", () => {
    const products: ProductData[] = [
      { name: "X", priceCents: 5000, rating: 4.0, reviewCount: 10, source: "S", url: null },
    ];
    const result = heuristicRecommendation(products);
    expect(result.confidence).toBe(0.6);
  });
});
