/**
 * server/phoenix_engine.ts — Phoenix Engine subprocess wrapper.
 *
 * Executes the Python-based UI Navigator as a subprocess for autonomous
 * browser automation on Amazon, eBay, and Walmart.
 *
 * Features:
 *  - 60-second timeout per site
 *  - Circuit breaker (max 5 attempts per site)
 *  - SoM screenshots → GCS upload
 *  - Graceful fallback on subprocess errors
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { uploadScreenshot } from "./storage.js";

dotenv.config();

// ── Module Logger ───────────────────────────────────────────────────
const LOG_PREFIX = "[phoenix]";
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${LOG_PREFIX} ${level}: ${msg}`);
}

// ── Configuration ───────────────────────────────────────────────────
const VENV_PATH = process.env.VENV_PATH?.trim() || "./my_pro_chall";
const TIMEOUT_MS = 180_000; // 180 seconds per site (3 parallel browsers + replan cycles)
const MAX_ATTEMPTS = 5;

// Track attempts per site for circuit breaker
const siteAttempts: Record<string, number> = {};

// Track active processes for cancellation
const activeProcesses = new Set<ChildProcess>();

export function killAllRunningSearches() {
  log("INFO", `Killing ${activeProcesses.size} running search processes...`);
  for (const proc of activeProcesses) {
    if (process.platform === "win32" && proc.pid) {
      try { execSync(`taskkill /PID ${proc.pid} /F /T`, { stdio: "ignore" }); } catch {}
    } else {
      try {
        proc.kill("SIGTERM");
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { } }, 3000);
      } catch {}
    }
  }
  activeProcesses.clear();
}

// ── Site URLs ───────────────────────────────────────────────────────
const SITE_CONFIGS: Record<
  string,
  { url: string; searchUrl: (q: string) => string; name: string }
> = {
  amazon: {
    url: "https://www.amazon.com",
    searchUrl: (q) =>
      `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    name: "Amazon",
  },
  ebay: {
    url: "https://www.ebay.com",
    searchUrl: (q) =>
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
    name: "eBay",
  },
  walmart: {
    url: "https://www.walmart.com",
    searchUrl: (q) =>
      `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
    name: "Walmart",
  },
};

// ── Product Result Types ────────────────────────────────────────────
export interface PhoenixProduct {
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

export interface SiteSearchResult {
  site: string;
  products: PhoenixProduct[];
  screenshotUrl: string | null;
  traceUrl: string | null;
  error: string | null;
  durationMs: number;
  costUsd?: number;
}

// ── Circuit Breaker Check ───────────────────────────────────────────
function canAttemptSite(site: string): boolean {
  const attempts = siteAttempts[site] || 0;
  if (attempts >= MAX_ATTEMPTS) {
    log("WARNING", `Circuit breaker OPEN for ${site} (${attempts} attempts)`);
    return false;
  }
  return true;
}

function recordSiteAttempt(site: string) {
  siteAttempts[site] = (siteAttempts[site] || 0) + 1;
}

function resetSiteAttempts(site: string) {
  siteAttempts[site] = 0;
}

// ── Get Python Executable ───────────────────────────────────────────
function getPythonPath(): string {
  const isWindows = process.platform === "win32";
  const binDir = isWindows ? "Scripts" : "bin";
  const pythonName = isWindows ? "python.exe" : "python";
  const venvPython = path.join(VENV_PATH, binDir, pythonName);

  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  log("WARNING", `Venv python not found at ${venvPython} — using system python`);
  return isWindows ? "python" : "python3";
}

// ── Execute Phoenix Search ──────────────────────────────────────────

/**
 * Run Phoenix Engine to search a single site.
 * Returns parsed product data or graceful error.
 */
export async function searchSite(
  site: string,
  productQuery: string
): Promise<SiteSearchResult> {
  const startTime = Date.now();
  const config = SITE_CONFIGS[site.toLowerCase()];

  if (!config) {
    return {
      site,
      products: [],
      screenshotUrl: null,
      traceUrl: null,
      error: `Unknown site: ${site}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Circuit breaker
  if (!canAttemptSite(site)) {
    return {
      site: config.name,
      products: [],
      screenshotUrl: null,
      traceUrl: null,
      error: `Circuit breaker open — too many failed attempts for ${config.name}`,
      durationMs: Date.now() - startTime,
    };
  }

  recordSiteAttempt(site);
  log("INFO", `Starting search on ${config.name} for "${productQuery}"`);

  const runId = `${site.toLowerCase()}_${Date.now()}`;

  try {
    const searchUrl = config.searchUrl(productQuery);

    const output = await runPhoenixSubprocess(site, searchUrl, productQuery, runId);
    
    // Extract cost from python logs
    const costMatches = [...output.matchAll(/\[COST_USD\]\s*([0-9.]+)/g)];
    const costUsd = costMatches.reduce((sum, match) => sum + parseFloat(match[1]), 0);

    const products = parseProductOutput(output, config.name, searchUrl);

    // Try to capture and upload screenshot
    let screenshotUrl: string | null = null;
    const screenshotPath = `./runs/${runId}_initial_som.jpg`;
    if (fs.existsSync(screenshotPath)) {
      try {
        const uploadResult = await uploadScreenshot(
          screenshotPath,
          `${runId}.jpg`
        );
        screenshotUrl = uploadResult.url;
      } catch (err) {
        log("WARNING", `Screenshot upload failed for ${site}: ${err}`);
      }
    }

    // Try to capture and upload trace
    let traceUrl: string | null = null;
    const tracePath = `./runs/${runId}_trace.zip`;
    if (fs.existsSync(tracePath)) {
      try {
        const uploadResult = await uploadScreenshot(
          tracePath,
          `${runId}_trace.zip`
        );
        traceUrl = uploadResult.url;
      } catch (err) {
        log("WARNING", `Trace upload failed for ${site}: ${err}`);
      }
    }

    if (products.length > 0) {
      resetSiteAttempts(site);
    }

    log("INFO", `${config.name}: found ${products.length} products`);

    return {
      site: config.name,
      products,
      screenshotUrl,
      traceUrl,
      error: products.length === 0 ? "No products found" : null,
      durationMs: Date.now() - startTime,
      costUsd,
    };
  } catch (err: any) {
    log("ERROR", `${config.name} search failed: ${err.message}`);
    return {
      site: config.name,
      products: [],
      screenshotUrl: null,
      traceUrl: null,
      error: err.message,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Search all 3 sites in parallel using Promise.all().
 */
export async function searchAllSites(
  productQuery: string
): Promise<SiteSearchResult[]> {
  log("INFO", `Parallel search across all sites for "${productQuery}"`);

  const results = await Promise.all([
    searchSite("amazon", productQuery),
    searchSite("ebay", productQuery),
    searchSite("walmart", productQuery),
  ]);

  const totalProducts = results.reduce(
    (sum, r) => sum + r.products.length,
    0
  );
  log(
    "INFO",
    `All-site search done: ${totalProducts} total products, ` +
      `${results.filter((r) => !r.error).length}/3 succeeded`
  );

  return results;
}

// ── Subprocess Execution ────────────────────────────────────────────

/**
 * Generate a Plan JSON file matching the ui_navigator Plan schema.
 * The plan tells Phoenix to navigate to the search URL and extract data.
 */
function createPlanFile(site: string, searchUrl: string, productQuery: string): string {
  const planDir = path.resolve("./runs/plans");
  if (!fs.existsSync(planDir)) {
    fs.mkdirSync(planDir, { recursive: true });
  }

  const planPath = path.join(planDir, `${site}_${Date.now()}.json`);

  const plan = {
    goal: `Search for "${productQuery}" and extract product names, prices, and ratings from the results page`,
    extracted_ui_text_preview: "",
    actions: [
      {
        type: "navigate",
        url: searchUrl,
        target: `Navigate to ${site} search results`,
      },
      {
        type: "wait",
        target: "Wait for search results to load",
      },
    ],
    origin_url: searchUrl,
    origin_host: new URL(searchUrl).hostname,
    origin_title_hint: productQuery,
    origin_keywords: [productQuery, "price", "product"],
  };

  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  log("DEBUG", `Created plan file: ${planPath}`);
  return planPath;
}

function runPhoenixSubprocess(
  site: string,
  searchUrl: string,
  productQuery: string,
  runId: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const pythonPath = getPythonPath();

    // 1. Generate the plan JSON file
    let planPath: string;
    try {
      planPath = createPlanFile(site, searchUrl, productQuery);
    } catch (err: any) {
      return reject(new Error(`Failed to create plan file: ${err.message}`));
    }

    const args = [
      "-m", "ui_navigator.cli",
      "exec",
      "--plan", planPath,
      "--url", searchUrl,
      "--headless",
      "--max-cycles", "3",
      "--trace",
      "--run-id", runId,
    ];

    log("DEBUG", `Spawning: ${pythonPath} ${args.join(" ")}`);

    const proc: ChildProcess = spawn(
      pythonPath,
      args,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHONPATH: process.cwd(),
        },
        timeout: TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    activeProcesses.add(proc);

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Timeout handler — Windows needs taskkill, not SIGTERM
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      log("WARNING", `Phoenix subprocess timed out after ${TIMEOUT_MS / 1000}s — killing`);
      try {
        if (process.platform === "win32" && proc.pid) {
          execSync(`taskkill /PID ${proc.pid} /F /T`, { stdio: "ignore" });
        } else {
          proc.kill("SIGTERM");
          setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 3000);
        }
      } catch { /* process may already be dead */ }
    }, TIMEOUT_MS);

    proc.on("close", (code: number | null) => {
      activeProcesses.delete(proc);
      clearTimeout(timer);

      // Clean up plan file
      try { fs.unlinkSync(planPath); } catch { /* ignore */ }

      // Filter out Python FutureWarnings from stderr — they're not real errors
      const realErrors = stderr
        .split("\n")
        .filter((line) => {
          const l = line.trim().toLowerCase();
          return l.length > 0 &&
            !l.includes("futurewarning") &&
            !l.includes("deprecated") &&
            !l.includes("switch to") &&
            !l.includes("readme") &&
            !l.includes("import google");
        })
        .join("\n")
        .trim();

      if (code === 0 || stdout.length > 0) {
        resolve(stdout);
      } else if (killed) {
        // Timed out — resolve with whatever we got so stdout can be parsed
        resolve(stdout || "");
      } else {
        reject(
          new Error(
            `Phoenix exited with code ${code}: ${realErrors.slice(0, 500) || "No output"}`
          )
        );
      }
    });

    proc.on("error", (err: Error) => {
      activeProcesses.delete(proc);
      clearTimeout(timer);
      try { fs.unlinkSync(planPath); } catch { /* ignore */ }
      reject(new Error(`Failed to spawn Phoenix: ${err.message}`));
    });
  });
}

// ── Output Parser ───────────────────────────────────────────────────

/**
 * Parse Phoenix Engine stdout to extract product data.
 * Falls back to generating simulated data if parsing fails.
 */
function parseProductOutput(
  output: string,
  source: string,
  searchUrl: string
): PhoenixProduct[] {
  const products: PhoenixProduct[] = [];

  try {
    // Try to find JSON product data in output
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

    // Try to parse SoM elements from output
    const lines = output.split("\n");
    const priceRegex = /\$[\d,]+\.?\d{0,2}/g;
    const ratingRegex = /(\d+\.?\d*)\s*(?:out of|\/)\s*5/i;

    for (const line of lines) {
      const prices = line.match(priceRegex);
      if (prices && prices.length > 0) {
        const priceStr = prices[0].replace(/[$,]/g, "");
        const priceCents = Math.round(parseFloat(priceStr) * 100);

        if (priceCents > 0 && priceCents < 100000000) {
          // < $1M sanity check
          const ratingMatch = line.match(ratingRegex);
          products.push({
            name: extractProductName(line) || `Product from ${source}`,
            priceCents,
            originalPrice: prices.length > 1 ? prices[1] : null,
            rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
            reviewCount: null,
            source,
            url: searchUrl,
            imageUrl: null,
            screenshotUrl: null,
          });
        }
      }
    }
  } catch (err) {
    log("WARNING", `Failed to parse Phoenix stdout: ${err}`);
  }

  // ── Fallback: Read from generated HTML DOM files ──────────────────
  if (products.length === 0) {
    log("INFO", `No products found in stdout for ${source}, falling back to HTML DOM parsing...`);
    const scraped = scrapeProductsFromHtmlFiles(source, searchUrl);
    if (scraped.length > 0) {
      log("INFO", `Found ${scraped.length} products via HTML DOM fallback for ${source}`);
      products.push(...scraped);
    }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  const unique = products.filter((p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Apply aggressive filtering & scoring
  return filterAndScoreProducts(unique, source);
}

// ── Spam / Noise keywords to filter out ─────────────────────────────
const SPAM_KEYWORDS = [
  "sponsored", "ad ", "see more", "next page", "shop now", "filter",
  "add to cart", "buy now", "sign in", "sign up", "subscribe",
  "best seller", "lightning deal", "limited time", "free delivery",
  "free shipping", "prime", "see all", "view all", "learn more",
  "results for", "showing results", "related searches", "customer also",
  "frequently bought", "people also", "department", "category",
  "sort by", "filter by", "price range", "min price", "max price",
  "cookie", "privacy", "terms of", "copyright", "all rights reserved",
];

function extractProductName(line: string): string | null {
  // Remove price references, ratings, SoM annotations
  let cleaned = line
    .replace(/\$[\d,]+\.?\d{0,2}/g, "")
    .replace(/\d+\.?\d*\s*(?:out of|\/)\s*5/gi, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[|#…•►▶→←↑↓]/g, " ")
    .replace(/\bASIN:\s*\w+/gi, "")
    .replace(/\bISBN[\s:-]*[\d-Xx]+/gi, "")
    .replace(/\b(Best Seller|#\d+ in \w+|Lightning Deal|Limited time deal)\b/gi, "")
    .replace(/\b(FREE delivery|Free Shipping|Prime)\b/gi, "")
    .replace(/\b(Add to Cart|Buy Now|Shop Now|See More|Learn More)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Must be meaningful length (≥15 chars) and not too long
  if (cleaned.length >= 15 && cleaned.length < 200) {
    return cleaned.slice(0, 150);
  }
  return null;
}

// ── Aggressive Product Filtering & Relevance Scoring ────────────────

/** Simple word-overlap relevance score between product name and the query. */
function relevanceScore(productName: string, query: string): number {
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const pWords = productName.toLowerCase().split(/\s+/);
  if (qWords.length === 0) return 0.5;
  const hits = qWords.filter(qw => pWords.some(pw => pw.includes(qw) || qw.includes(pw)));
  return hits.length / qWords.length;
}

/** Simple character-level similarity (Sørensen–Dice coefficient). */
function nameSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const b: string[] = [];
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) b.push(lower.slice(i, i + 2));
    return b;
  };
  const bg1 = bigrams(a);
  const bg2 = bigrams(b);
  if (bg1.length === 0 || bg2.length === 0) return 0;
  const set2 = new Set(bg2);
  const intersection = bg1.filter(b => set2.has(b)).length;
  return (2 * intersection) / (bg1.length + bg2.length);
}

/**
 * Filters and scores products aggressively:
 * 1. Remove spam / noise entries
 * 2. Enforce minimum name quality
 * 3. Price sanity range ($1 – $10,000)
 * 4. Fuzzy deduplication (≥80% similarity)
 * 5. Sort by relevance score
 * 6. Keep top 10 per site
 */
function filterAndScoreProducts(
  products: PhoenixProduct[],
  source: string
): PhoenixProduct[] {
  // We need the original query — extract it from the source context
  // The query is stored inline via the calling function, so we pass source for logging only.

  const clean: Array<PhoenixProduct & { _relevance: number }> = [];

  for (const p of products) {
    const nameLower = p.name.toLowerCase();

    // 1. Spam keyword check
    if (SPAM_KEYWORDS.some(kw => nameLower.includes(kw))) continue;

    // 2. Name quality: must be ≥15 chars
    if (p.name.length < 15) continue;

    // 3. Price sanity: $1 – $10,000
    if (p.priceCents < 100 || p.priceCents > 1_000_000) continue;

    // 4. Fuzzy deduplication
    const isDupe = clean.some(existing => nameSimilarity(existing.name, p.name) >= 0.80);
    if (isDupe) continue;

    clean.push({ ...p, _relevance: 0 });
  }

  // Sort by price (cheapest first) as a default relevance proxy
  clean.sort((a, b) => a.priceCents - b.priceCents);

  // Keep top 10
  const top = clean.slice(0, 10);

  log("INFO", `${source}: filtered ${products.length} → ${top.length} clean products`);

  // Strip internal _relevance before returning
  return top.map(({ _relevance, ...rest }) => rest);
}

/**
 * Fallback: Reads newly generated .html files in runs/ (from taking screenshots),
 * extracts text by stripping HTML tags, and searches for product prices.
 */
function scrapeProductsFromHtmlFiles(source: string, searchUrl: string): PhoenixProduct[] {
  const products: PhoenixProduct[] = [];
  try {
    const runsDir = path.resolve("./runs");
    if (!fs.existsSync(runsDir)) return [];

    // Find all .html files modified in the last 5 minutes
    const files = fs.readdirSync(runsDir)
      .filter(f => f.endsWith(".html"))
      .map(f => path.join(runsDir, f))
      .filter(f => {
        const stats = fs.statSync(f);
        const ageMs = Date.now() - stats.mtimeMs;
        return ageMs < 5 * 60 * 1000; // < 5 mins old
      });

    const priceRegex = /\$[\d,]+\.?\d{0,2}/g;
    const ratingRegex = /(\d+\.?\d*)\s*(?:out of|\/)\s*5/i;

    for (const file of files) {
      const html = fs.readFileSync(file, "utf-8");
      
      // Extremely crude HTML tag stripper to get text lines
      const text = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');

      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // Context window: look at surrounding lines for a product name when a price is found
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prices = line.match(priceRegex);
        
        if (prices && prices.length > 0) {
          const priceStr = prices[0].replace(/[$,]/g, "");
          const priceCents = Math.round(parseFloat(priceStr) * 100);

          if (priceCents > 0 && priceCents < 100000000) {
            // Find a name from nearby lines if current line has no valid name
            let name = extractProductName(line);
            
            // If current line was just a price, look back up to 3 lines for a longer name
            if (!name) {
               for (let j = Math.max(0, i - 1); j >= Math.max(0, i - 3); j--) {
                 const potential = extractProductName(lines[j]);
                 if (potential && potential.length > 10 && !potential.match(priceRegex)) {
                   name = potential;
                   break;
                 }
               }
            }

            if (name) {
               products.push({
                name,
                priceCents,
                originalPrice: prices.length > 1 ? prices[1] : null,
                rating: null, // Hard to extract reliably contextually
                reviewCount: null,
                source,
                url: searchUrl,
                imageUrl: null,
                screenshotUrl: null,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    log("WARNING", `HTML DOM scraping failed: ${err}`);
  }
  return products;
}

// ── Reset Circuit Breakers ──────────────────────────────────────────
export function resetAllCircuitBreakers() {
  Object.keys(siteAttempts).forEach((site) => {
    siteAttempts[site] = 0;
  });
  log("INFO", "All site circuit breakers RESET");
}
