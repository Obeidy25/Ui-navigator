/**
 * server/gemini_integration.ts — Google Gemini API integration with circuit breaker.
 *
 * Uses @google/generativeai exclusively with gemini-2.0-flash-exp.
 * Implements circuit breaker pattern: 3 failures → 30s heuristic fallback.
 * All errors are caught and logged — never crashes the app.
 */

import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

// ── Module Logger ───────────────────────────────────────────────────
const LOG_PREFIX = "[gemini]";
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${LOG_PREFIX} ${level}: ${msg}`);
}

// ── Circuit Breaker ─────────────────────────────────────────────────
const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 30_000;

class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";

  allow(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= CB_COOLDOWN_MS) {
        this.state = "HALF_OPEN";
        log("INFO", "Circuit HALF_OPEN — probing Gemini");
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN: allow one probe
  }

  recordSuccess() {
    if (this.state !== "CLOSED") {
      log("INFO", "Circuit CLOSED — Gemini recovered");
    }
    this.failures = 0;
    this.state = "CLOSED";
  }

  recordFailure() {
    this.failures++;
    if (this.state === "HALF_OPEN" || this.failures >= CB_THRESHOLD) {
      this.openedAt = Date.now();
      const prev = this.state;
      this.state = "OPEN";
      if (prev !== "OPEN") {
        log(
          "WARNING",
          `Circuit OPEN after ${this.failures} failures. Fallback for ${CB_COOLDOWN_MS / 1000}s.`
        );
      }
    }
  }

  get isOpen(): boolean {
    return this.state === "OPEN";
  }

  get isQuotaExceeded(): boolean {
    return this._quotaExceeded;
  }

  recordQuotaExceeded() {
    this._quotaExceeded = true;
    this.openedAt = Date.now();
    this.state = "OPEN";
    log("WARNING", "Gemini API quota exceeded — free tier limit reached");
  }

  private _quotaExceeded = false;
}

const circuitBreaker = new CircuitBreaker();

// ── Gemini Client ───────────────────────────────────────────────────
let model: GenerativeModel | null = null;

function getModel(): GenerativeModel | null {
  if (model) return model;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    log("ERROR", "GEMINI_API_KEY not set — Gemini features disabled");
    return null;
  }
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    log("INFO", "Gemini model initialized (gemini-2.5-flash)");
    return model;
  } catch (err) {
    log("ERROR", `Failed to initialize Gemini: ${err}`);
    return null;
  }
}

// ── Product Analysis Types ──────────────────────────────────────────
export interface ProductData {
  name: string;
  priceCents: number;
  rating: number | null;
  reviewCount: number | null;
  source: string;
  url: string | null;
}

export interface GeminiRecommendation {
  bestDeal: string;
  reasoning: string;
  savingsEstimateCents: number;
  riskFactors: string[];
  confidence: number;
}

// ── Analyze Products ────────────────────────────────────────────────
export async function analyzeProducts(
  products: ProductData[],
  productQuery: string
): Promise<GeminiRecommendation> {
  // Circuit breaker check
  if (!circuitBreaker.allow()) {
    if (circuitBreaker.isQuotaExceeded) {
      throw new Error("QUOTA_EXCEEDED");
    }
    log("WARNING", "Circuit breaker OPEN — using heuristic fallback");
    return heuristicRecommendation(products);
  }

  const gemini = getModel();
  if (!gemini) {
    return heuristicRecommendation(products);
  }

  try {
    const prompt = buildAnalysisPrompt(products, productQuery);
    const result = await gemini.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    circuitBreaker.recordSuccess();
    log("INFO", `Gemini analysis complete (${text.length} chars)`);

    return parseGeminiResponse(text, products);
  } catch (err: any) {
    const errMsg = String(err?.message || err);
    log("ERROR", `Gemini analysis failed: ${errMsg}`);

    // Detect quota / rate limit errors (HTTP 429 or quota keywords)
    if (
      errMsg.includes("429") ||
      errMsg.toLowerCase().includes("quota") ||
      errMsg.toLowerCase().includes("rate limit") ||
      errMsg.toLowerCase().includes("resource has been exhausted")
    ) {
      circuitBreaker.recordQuotaExceeded();
      throw new Error("QUOTA_EXCEEDED");
    }

    circuitBreaker.recordFailure();
    return heuristicRecommendation(products);
  }
}

/** Stream-based analysis for real-time feedback. */
export async function analyzeProductsStream(
  products: ProductData[],
  productQuery: string,
  onChunk: (text: string) => void
): Promise<GeminiRecommendation> {
  if (!circuitBreaker.allow()) {
    log("WARNING", "Circuit breaker OPEN — using heuristic fallback (stream)");
    return heuristicRecommendation(products);
  }

  const gemini = getModel();
  if (!gemini) {
    return heuristicRecommendation(products);
  }

  try {
    const prompt = buildAnalysisPrompt(products, productQuery);
    const result = await gemini.generateContentStream(prompt);

    let fullText = "";
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      fullText += chunkText;
      onChunk(chunkText);
    }

    circuitBreaker.recordSuccess();
    log("INFO", `Gemini stream analysis complete (${fullText.length} chars)`);
    return parseGeminiResponse(fullText, products);
  } catch (err) {
    log("ERROR", `Gemini stream analysis failed: ${err}`);
    circuitBreaker.recordFailure();
    return heuristicRecommendation(products);
  }
}

// ── Smart Alternatives ──────────────────────────────────────────────
export async function generateSemanticAlternatives(
  query: string,
  priceCents: number
): Promise<string[]> {
  const gemini = getModel();
  if (!gemini || !circuitBreaker.allow()) return [];

  const priceStr = `$${(priceCents / 100).toFixed(2)}`;
  const prompt = `The user is searching for "${query}" with a budget around ${priceStr}.
Suggest 3 specific alternative product models that are very similar in features and quality, but are generally cheaper or better value for money.

Respond ONLY with a JSON array of 3 strings (the product names). Do not include markdown formatting or extra text. Example: ["Alternative 1", "Alternative 2", "Alternative 3"]`;

  try {
    const result = await gemini.generateContent(prompt);
    let text = result.response.text().trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
  } catch (err) {
    log("ERROR", `Failed to generate alternatives: ${err}`);
    return [];
  }
}

// ── Sentiment Extraction ────────────────────────────────────────────
export async function extractSentimentTags(productName: string): Promise<string[]> {
  const gemini = getModel();
  if (!gemini || !circuitBreaker.allow()) return [];

  const prompt = `Analyze this product listing title: "${productName}"
Based on your extensive knowledge of this product or brand, what are 2 short, common sentiment tags or key features associated with it?
  
Examples of tags: "Great Battery", "Runs Hot", "Refurbished Risk", "Budget Pick", "Premium Build".

Respond ONLY with a JSON array of 2 very short strings. Example: ["Tag 1", "Tag 2"]`;

  try {
    const result = await gemini.generateContent(prompt);
    let text = result.response.text().trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.slice(0, 2) : [];
  } catch (err) {
    log("ERROR", `Failed to extract sentiment tags: ${err}`);
    return [];
  }
}

// ── AI-Powered Product Cleaning ─────────────────────────────────────
/**
 * Ask Gemini to filter a raw product list and return only relevant products.
 * This is a "smart filter" that removes ads, accessories, and irrelevant items.
 * Returns { cleaned: ProductData[], rawCount: number, cleanedCount: number }.
 */
export async function cleanProductsWithAI(
  products: ProductData[],
  query: string
): Promise<{ cleaned: ProductData[]; rawCount: number; cleanedCount: number }> {
  const rawCount = products.length;

  // If few products, skip AI call
  if (products.length <= 3) {
    return { cleaned: products, rawCount, cleanedCount: products.length };
  }

  const gemini = getModel();
  if (!gemini || !circuitBreaker.allow()) {
    return { cleaned: products, rawCount, cleanedCount: products.length };
  }

  const productList = products
    .map((p, i) => `${i}: "${p.name}" — $${(p.priceCents / 100).toFixed(2)} [${p.source}]`)
    .join("\n");

  const prompt = `You are a strict product relevance filter. The user searched for: "${query}".

Here are ${products.length} scraped product listings:
${productList}

Return ONLY a JSON array of the index numbers (0-based) of the products that are **genuinely relevant** to the search query "${query}". 
Remove any:
- Advertisements or sponsored placements
- Accessories, cases, cables unrelated to the main product
- Completely unrelated products
- Duplicate products with slightly different names

Example response: [0, 2, 5, 7]
Respond ONLY with the JSON array, nothing else.`;

  try {
    const result = await gemini.generateContent(prompt);
    let text = result.response.text().trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    }
    const indices: number[] = JSON.parse(text);
    if (Array.isArray(indices)) {
      const cleaned = indices
        .filter((i) => typeof i === "number" && i >= 0 && i < products.length)
        .map((i) => products[i]);
      log("INFO", `AI cleaning: ${rawCount} → ${cleaned.length} relevant products for "${query}"`);
      return { cleaned, rawCount, cleanedCount: cleaned.length };
    }
  } catch (err) {
    log("WARNING", `AI product cleaning failed: ${err}`);
  }

  return { cleaned: products, rawCount, cleanedCount: products.length };
}

// ── Prompt Builder ──────────────────────────────────────────────────
function buildAnalysisPrompt(products: ProductData[], query: string): string {
  const productList = products
    .map(
      (p, i) =>
        `${i + 1}. ${p.name} — $${(p.priceCents / 100).toFixed(2)} ` +
        `(Rating: ${p.rating ?? "N/A"}, Reviews: ${p.reviewCount ?? "N/A"}) ` +
        `[${p.source}]`
    )
    .join("\n");

  return `You are a shopping price analysis expert. Analyze these products found for the query "${query}" and recommend the best deal.

Products found:
${productList}

Respond in this EXACT JSON format:
{
  "bestDeal": "Product name that is the best deal",
  "reasoning": "2-3 sentence explanation of why this is the best deal, considering price, rating, reviews, and seller reputation",
  "savingsEstimateCents": <estimated savings in cents compared to average price>,
  "riskFactors": ["list", "of", "risk", "factors"],
  "confidence": <0.0 to 1.0 confidence score>
}

Only respond with valid JSON, no markdown or extra text.`;
}

// ── Response Parser ─────────────────────────────────────────────────
function parseGeminiResponse(
  text: string,
  products: ProductData[]
): GeminiRecommendation {
  try {
    // Strip markdown code fences if present
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
    log("WARNING", "Failed to parse Gemini JSON — using heuristic");
    return heuristicRecommendation(products);
  }
}

// ── Heuristic Fallback ──────────────────────────────────────────────
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

  // Sort by price, weighted by rating
  const scored = products
    .map((p) => ({
      ...p,
      score:
        (1 / Math.max(p.priceCents, 1)) * 10000 +
        (p.rating ?? 0) * 100 +
        Math.min(p.reviewCount ?? 0, 1000) * 0.1,
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const avgPrice =
    products.reduce((sum, p) => sum + p.priceCents, 0) / products.length;
  const savings = Math.max(0, Math.round(avgPrice - best.priceCents));

  return {
    bestDeal: best.name,
    reasoning: `Best value based on price ($${(best.priceCents / 100).toFixed(2)}) and rating (${best.rating ?? "N/A"}). Heuristic analysis — Gemini unavailable.`,
    savingsEstimateCents: savings,
    riskFactors: ["Analysis based on heuristic (Gemini circuit breaker active)"],
    confidence: 0.6,
  };
}

// ── Interactive Pre-Search Questionnaire ────────────────────────────

export interface PreSearchQuestion {
  id: string;
  question: string;
  options: string[];
}

export async function generatePreSearchQuestions(
  productName: string,
  category: string
): Promise<PreSearchQuestion[]> {
  const gemini = getModel();
  if (!gemini || !circuitBreaker.allow()) return [];

  const prompt = `You are Phoenix, an expert AI shopping assistant. 
The user wants to buy: "${productName}" (Category: ${category}).
Before searching Amazon/eBay/Walmart, you need to deeply understand their specific needs to find the perfect match.

Generate exactly 3 short, targeted multiple-choice questions to narrow down their requirements (e.g., budget, main use case, preferred feature, size, etc.).
Make the questions sound natural and helpful.

Respond ONLY with a valid JSON array of objects.
Example format:
[
  {
    "id": "q1",
    "question": "What is your primary use case for this?",
    "options": ["Gaming & Performance", "Office & Productivity", "Casual/Home use"]
  }
]`;

  try {
    const result = await gemini.generateContent(prompt);
    let text = result.response.text().trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log("ERROR", `Failed to generate pre-search questions: ${err}`);
    return [];
  }
}

export async function refineSearchQuery(
  originalProduct: string,
  answers: Record<string, string>
): Promise<string> {
  const gemini = getModel();
  // If API fails or no answers, fallback to original product name
  if (!gemini || !circuitBreaker.allow() || Object.keys(answers).length === 0) {
    return originalProduct;
  }

  const prompt = `The user originally searched for: "${originalProduct}".
I asked them clarifying questions and they provided these answers:
${JSON.stringify(answers, null, 2)}

Your task is to combine the original product name with their specific requirements into a highly optimized, short search query (max 4-5 words) suitable for an e-commerce search bar (like Amazon/eBay).
Do NOT include filler words like "for", "with", "under". Just the core keywords.

Respond ONLY with the final search query string. No quotes, no markdown.`;

  try {
    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim();
    return text || originalProduct;
  } catch (err) {
    log("ERROR", `Failed to refine search query: ${err}`);
    return originalProduct;
  }
}
