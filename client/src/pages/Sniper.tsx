/**
 * client/src/pages/Sniper.tsx — Phoenix Shopping Sniper UI.
 *
 * Full shopping comparison interface with:
 *  - Search form (product name, category, max price)
 *  - Real-time loading indicators
 *  - Sortable results table
 *  - Gemini AI recommendation card
 *  - Statistics dashboard
 *  - Search history with re-run buttons
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { trpc } from "../utils/trpc.js";
import Chatbot from "../components/Chatbot.js";

// ── Types ───────────────────────────────────────────────────────────
interface ProductResult {
  name: string;
  priceCents: number;
  priceDisplay: string;
  rating: number | null;
  reviewCount: number | null;
  source: string;
  url: string | null;
  sentimentTags?: string[];
}

interface Recommendation {
  bestDeal: string;
  reasoning: string;
  savingsEstimateCents: number;
  riskFactors: string[];
  confidence: number;
}

interface SearchResponse {
  searchId: number;
  products: ProductResult[];
  recommendation: Recommendation | null;
  siteResults?: {
    site: string;
    productCount: number;
    error: string | null;
    durationMs: number;
    screenshotUrl: string | null;
  }[];
  alternatives?: string[];
  isCached?: boolean;
  dataQuality?: {
    rawCount: number;
    cleanedCount: number;
  };
}

// ── Category Options ────────────────────────────────────────────────
const CATEGORIES = [
  { value: "general", label: "🔍 All Categories" },
  { value: "electronics", label: "💻 Electronics" },
  { value: "clothing", label: "👕 Clothing" },
  { value: "home", label: "🏠 Home & Garden" },
  { value: "toys", label: "🧸 Toys & Games" },
  { value: "sports", label: "⚽ Sports" },
  { value: "books", label: "📚 Books" },
  { value: "auto", label: "🚗 Automotive" },
  { value: "grocery", label: "🛒 Grocery" },
] as const;

// ── Sort Options ────────────────────────────────────────────────────
type SortKey = "price" | "rating" | "source";

// ── Component ───────────────────────────────────────────────────────
export default function Sniper() {
  // Form state
  const [productName, setProductName] = useState("");
  const [category, setCategory] = useState<string>("general");
  const [maxPrice, setMaxPrice] = useState("");

  // Results state
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("price");
  const [sortAsc, setSortAsc] = useState(true);

  // Agentic UI state (Function Calling)
  const [checkoutProduct, setCheckoutProduct] = useState<{productName: string, priceCents: number} | null>(null);
  const [favoriteToast, setFavoriteToast] = useState<string | null>(null);

  const handleAgentAction = useCallback((action: { name: string, args: any }) => {
    if (action.name === "initiateCheckout") {
      setCheckoutProduct(action.args);
    } else if (action.name === "addToFavorites") {
      setFavoriteToast(`❤️ Added ${action.args.productName} to favorites!`);
      setTimeout(() => setFavoriteToast(null), 4000);
    }
  }, []);

  // Loading
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState("");
  const [narrationLog, setNarrationLog] = useState<string[]>([]);
  // ── Questionnaire State ───────────────────────────────────────────
  const [questionnaireStatus, setQuestionnaireStatus] = useState<'idle' | 'generating' | 'asking' | 'refining' | 'searching'>('idle');
  const [questions, setQuestions] = useState<any[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refinedProductName, setRefinedProductName] = useState("");

  const [error, setError] = useState<string | null>(null);
  const narrationRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('cards');

  // ── Keyboard Shortcuts ──────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCheckoutProduct(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // tRPC mutations & queries
  const generateQuestionsMutation = trpc.sniper.generateQuestions.useMutation();
  const refineQueryMutation = trpc.sniper.refineQuery.useMutation();
  const searchMutation = trpc.sniper.search.useMutation();
  const rerunMutation = trpc.sniper.rerunSearch.useMutation();
  const clearHistoryMutation = trpc.sniper.clearHistory.useMutation();
  const abortSearchMutation = trpc.sniper.abortSearch.useMutation();
  const statsQuery = trpc.sniper.getStats.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const historyQuery = trpc.sniper.getHistory.useQuery(
    { limit: 10 },
    { refetchInterval: 15000 }
  );

  // ── 1. Search Trigger (Starts Questionnaire) ──────────────────────
  const handleSearch = useCallback(async () => {
    if (!productName.trim()) return;

    setError(null);
    setResults(null);
    setAnswers({});
    setRefinedProductName("");

    try {
      setQuestionnaireStatus('generating');
      const generatedQs = await generateQuestionsMutation.mutateAsync({
        productName: productName.trim(),
        category: category as any,
      });

      if (generatedQs && generatedQs.length > 0) {
        setQuestions(generatedQs);
        setQuestionnaireStatus('asking');
      } else {
        // Fallback: If AI fails to generate questions, just search directly.
        performActualSearch(productName.trim());
      }
    } catch (err: any) {
      console.error(`Questionnaire generation failed: ${err.message}`);
      // Fallback
      performActualSearch(productName.trim());
    }
  }, [productName, category, generateQuestionsMutation]);

  // ── 2. Handle User Answers ─────────────────────────────────────────
  const handleAnswerSelect = (questionId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
  };

  const submitAnswers = async () => {
    if (Object.keys(answers).length === 0) {
      performActualSearch(productName.trim());
      return;
    }

    try {
      setQuestionnaireStatus('refining');
      const refinedQuery = await refineQueryMutation.mutateAsync({
        productName: productName.trim(),
        answers,
      });
      setRefinedProductName(refinedQuery);
      performActualSearch(refinedQuery);
    } catch (err) {
      performActualSearch(productName.trim());
    }
  };

  const skipQuestionnaire = () => {
    performActualSearch(productName.trim());
  };

  // ── 3. The Actual Core Search Logic ────────────────────────────────
  const performActualSearch = async (finalQuery: string) => {
    setQuestionnaireStatus('searching');
    setIsSearching(true);
    setError(null);
    setSearchProgress("🔎 Initiating search across Amazon, eBay, Walmart...");
    setNarrationLog([]);

    try {
      // Phoenix Live Narration — agent tells user what it's doing
      const narrationSteps = [
        { delay: 0, msg: `🔎 Initiating search for "${finalQuery}" across Amazon, eBay, Walmart...` },
        { delay: 3000, msg: "🤖 Phoenix Engine activated — launching headless browsers..." },
        { delay: 6000, msg: "🌐 Navigating to Amazon search results..." },
        { delay: 9000, msg: "🕵️ Extracting product data using SoM analysis..." },
        { delay: 13000, msg: "🌐 Moving to eBay — scanning deals..." },
        { delay: 17000, msg: "🌐 Checking Walmart inventory..." },
        { delay: 22000, msg: "🧹 Filtering noise — keeping only relevant products..." },
        { delay: 27000, msg: "🧠 Gemini AI analyzing prices and generating recommendation..." },
        { delay: 33000, msg: "📊 Compiling final price comparison report..." },
        { delay: 40000, msg: "✨ Almost done — polishing results..." },
      ];

      const timers: NodeJS.Timeout[] = [];
      for (const step of narrationSteps) {
        const t = setTimeout(() => {
          setSearchProgress(step.msg);
          setNarrationLog(prev => [...prev, step.msg]);
        }, step.delay);
        timers.push(t);
      }

      const data = await searchMutation.mutateAsync({
        productName: finalQuery,
        category: category as any,
        maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      });

      timers.forEach(t => clearTimeout(t));
      setResults(data as SearchResponse);
      setSearchProgress("");
      statsQuery.refetch();
      historyQuery.refetch();
    } catch (err: any) {
      setError(err.message || "Search failed. Please try again.");
      setSearchProgress("");
    } finally {
      setIsSearching(false);
      setQuestionnaireStatus('idle');
    }
  };

  // ── Re-run Handler ────────────────────────────────────────────────
  const handleRerun = useCallback(
    async (searchId: number) => {
      setIsSearching(true);
      setError(null);
      setResults(null);
      setSearchProgress("🔄 Re-running previous search...");

      try {
        const data = await rerunMutation.mutateAsync({ searchId });
        setResults(data as SearchResponse);
        setSearchProgress("");
        statsQuery.refetch();
        historyQuery.refetch();
      } catch (err: any) {
        setError(err.message || "Re-run failed.");
        setSearchProgress("");
      } finally {
        setIsSearching(false);
      }
    },
    [rerunMutation, statsQuery, historyQuery]
  );

  // ── Sorting ───────────────────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(key);
      setSortAsc(true);
    }
  };

  const sortedProducts = results?.products
    ? [...results.products].sort((a, b) => {
        let cmp = 0;
        switch (sortBy) {
          case "price":
            cmp = a.priceCents - b.priceCents;
            break;
          case "rating":
            cmp = (b.rating ?? 0) - (a.rating ?? 0);
            break;
          case "source":
            cmp = a.source.localeCompare(b.source);
            break;
        }
        return sortAsc ? cmp : -cmp;
      })
    : [];

  const stats = statsQuery.data;
  const history = historyQuery.data;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="mx-auto max-w-7xl text-center mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-phoenix-500 to-phoenix-700 flex items-center justify-center text-2xl shadow-lg shadow-phoenix-500/30">
            🎯
          </div>
          <div>
            <h1 className="text-3xl sm:text-4xl font-extrabold bg-gradient-to-r from-phoenix-400 via-phoenix-300 to-yellow-200 bg-clip-text text-transparent">
              Phoenix Shopping Sniper
            </h1>
            <p className="text-sm text-gray-400 font-mono">
              Powered by Google Gemini · Phoenix Engine v11
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8">
        {/* Statistics Dashboard */}
        {stats && (
          <section className="animate-fade-in">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="stat-card">
                <p className="text-3xl font-bold text-phoenix-400">
                  {stats.totalSearches}
                </p>
                <p className="text-xs text-gray-400 mt-1 uppercase tracking-wider">
                  Searches
                </p>
              </div>
              <div className="stat-card">
                <p className="text-3xl font-bold text-green-400">
                  {stats.totalSavingsDisplay}
                </p>
                <p className="text-xs text-gray-400 mt-1 uppercase tracking-wider">
                  Total Savings
                </p>
              </div>
              <div className="stat-card">
                <p className="text-xl font-bold text-sniper-300 capitalize">
                  {stats.favoriteSite || "—"}
                </p>
                <p className="text-xs text-gray-400 mt-1 uppercase tracking-wider">
                  Favorite Site
                </p>
              </div>
              <div className="stat-card">
                <p className="text-sm font-medium text-gray-300">
                  {stats.lastSearchAt
                    ? new Date(stats.lastSearchAt).toLocaleDateString()
                    : "—"}
                </p>
                <p className="text-xs text-gray-400 mt-1 uppercase tracking-wider">
                  Last Search
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Search Form */}
        <section className="glass-card p-6 sm:p-8 animate-slide-up">
          <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
            <span className="text-phoenix-400">⚡</span> New Search
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-5">
              <label
                htmlFor="product-name"
                className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider"
              >
                Product Name
              </label>
              <input
                id="product-name"
                type="text"
                className="input-glass"
                placeholder="e.g. Sony WH-1000XM5 headphones"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                disabled={isSearching || questionnaireStatus !== 'idle'}
              />
            </div>
            <div className="sm:col-span-3">
              <label
                htmlFor="category-select"
                className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider"
              >
                Category
              </label>
              <select
                id="category-select"
                className="input-glass appearance-none cursor-pointer"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={isSearching || questionnaireStatus !== 'idle'}
              >
                {CATEGORIES.map((cat) => (
                  <option
                    key={cat.value}
                    value={cat.value}
                    className="bg-surface-800"
                  >
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label
                htmlFor="max-price"
                className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider"
              >
                Max Price ($)
              </label>
              <input
                id="max-price"
                type="number"
                className="input-glass"
                placeholder="500"
                min={0}
                step={0.01}
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                disabled={isSearching || questionnaireStatus !== 'idle'}
              />
            </div>
            <div className="sm:col-span-2 flex items-end gap-2">
              <button
                id="search-button"
                className="btn-phoenix flex-1"
                onClick={handleSearch}
                disabled={questionnaireStatus !== 'idle' || !productName.trim()}
              >
                {questionnaireStatus !== 'idle' ? (
                  <>
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Sniping...
                  </>
                ) : (
                  <>🎯 Snipe</>
                )}
              </button>
              {questionnaireStatus !== 'idle' && (
                <button
                  className="p-3 rounded-xl bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-all flex items-center justify-center w-12 shrink-0"
                  onClick={async () => {
                     try {
                       await abortSearchMutation.mutateAsync();
                       setIsSearching(false);
                       setQuestionnaireStatus('idle');
                       setSearchProgress("");
                       setError("Search cancelled by user.");
                     } catch (err) {
                       console.error("Failed to abort search", err);
                     }
                  }}
                  title="Cancel Search"
                >
                  ✖
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Free Tier Warning Banner */}
        <section className="glass-card border-amber-500/20 p-4 animate-slide-up">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 shrink-0 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-sm shadow-lg">
              🔑
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-300">Free API Key Detected</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                You are using a <span className="text-amber-400 font-medium">free Gemini API key</span> — AI-powered features (recommendations, sentiment tags, smart cleaning, chat) are limited.
                Upgrade to a <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-phoenix-400 hover:text-phoenix-300 underline font-medium">paid API key</a> to unlock the full Phoenix experience.
              </p>
            </div>
            <span className="text-[10px] text-gray-600 uppercase tracking-widest shrink-0">Free Tier</span>
          </div>
        </section>

        {/* ─── Interactive Pre-Search Questionnaire UI ───────────── */}
        {(questionnaireStatus === 'generating' || questionnaireStatus === 'asking' || questionnaireStatus === 'refining') && (
          <section className="glass-card p-6 sm:p-8 animate-fade-in border-phoenix-500/30 overflow-hidden relative">
            <div className="absolute inset-0 bg-gradient-to-br from-phoenix-900/40 via-transparent to-sniper-900/40 opacity-50"></div>
            <div className="relative z-10">
              {/* Header */}
              <div className="flex items-start gap-4 mb-6">
                <div className="h-14 w-14 shrink-0 rounded-2xl bg-gradient-to-br from-phoenix-500 to-phoenix-700 flex items-center justify-center text-3xl shadow-lg ring-2 ring-phoenix-500/20">
                  <span className="animate-pulse">🤖</span>
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-bold text-white mb-1">Phoenix AI Consultant</h2>
                  <p className="text-sm text-gray-300">
                    {questionnaireStatus === 'generating' && "Analyzing your request and preparing a few quick questions..."}
                    {questionnaireStatus === 'refining' && "Building the ultimate, laser-focused search query based on your needs..."}
                    {questionnaireStatus === 'asking' && "To find exactly what you want, answer these quick questions:"}
                  </p>
                </div>
              </div>

              {/* Status Indicators */}
              {(questionnaireStatus === 'generating' || questionnaireStatus === 'refining') && (
                <div className="flex items-center justify-center p-8">
                  <div className="flex flex-col items-center gap-4">
                    <div className="relative">
                      <div className="h-12 w-12 rounded-full border-t-2 border-b-2 border-phoenix-400 animate-spin"></div>
                      <div className="absolute inset-0 flex items-center justify-center text-lg">✨</div>
                    </div>
                    <p className="text-phoenix-300 font-mono text-sm animate-pulse">
                      {questionnaireStatus === 'generating' ? "Processing Context..." : "Optimizing Search Query..."}
                    </p>
                  </div>
                </div>
              )}

              {/* Questionnaire Form */}
              {questionnaireStatus === 'asking' && questions.length > 0 && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {questions.map((q, idx) => (
                      <div key={q.id} className="bg-white/[.03] border border-white/10 rounded-xl p-4 transition-all hover:bg-white/[.05]">
                        <p className="font-semibold text-white text-sm mb-3 h-10 flex flex-col justify-end">
                          <span className="text-phoenix-400 text-xs mb-1 uppercase tracking-widest font-mono">Question {idx + 1}</span>
                          {q.question}
                        </p>
                        <div className="space-y-2">
                          {q.options.map((opt: string, oIdx: number) => {
                            const isSelected = answers[q.id] === opt;
                            return (
                              <button
                                key={oIdx}
                                onClick={() => handleAnswerSelect(q.id, opt)}
                                className={`w-full text-left px-3 py-2 rounded-lg text-sm border transition-all ${
                                  isSelected
                                    ? 'bg-phoenix-500/20 border-phoenix-500/50 text-phoenix-300 shadow-[0_0_15px_rgba(234,88,12,0.15)] ring-1 ring-phoenix-500/30'
                                    : 'bg-white/[.02] border-white/5 text-gray-400 hover:border-white/20 hover:text-gray-300'
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <div className={`h-3 w-3 rounded-full border ${isSelected ? 'border-phoenix-400 bg-phoenix-400' : 'border-gray-500'}`}></div>
                                  <span className="truncate">{opt}</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-4 border-t border-white/10">
                    <button
                      onClick={skipQuestionnaire}
                      className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                    >
                      ⏭️ Skip & Search Anyway
                    </button>
                    <button
                      onClick={submitAnswers}
                      className="btn-phoenix px-8 py-2.5 text-sm"
                      disabled={Object.keys(answers).length === 0}
                    >
                      🚀 Search Now
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Phoenix Live Narration */}
        {isSearching && (
          <section className="glass-card p-6 relative overflow-hidden animate-slide-up">
            <div className="scan-effect" />
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br from-phoenix-500 to-phoenix-700 flex items-center justify-center text-xl shadow-lg shadow-phoenix-500/30">
                <span className="animate-pulse">🔥</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider">Phoenix Live Narration</h3>
                  <span className="inline-block h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                </div>
                {/* Narration Log */}
                <div ref={narrationRef} className="space-y-1.5 max-h-40 overflow-y-auto pr-2 scrollbar-thin">
                  {narrationLog.map((msg, i) => (
                    <p
                      key={i}
                      className={`text-sm font-mono transition-all duration-500 ${
                        i === narrationLog.length - 1
                          ? 'text-phoenix-300 font-semibold'
                          : 'text-gray-500'
                      }`}
                    >
                      {msg}
                    </p>
                  ))}
                  {narrationLog.length === 0 && (
                    <p className="text-sm text-gray-400 animate-pulse">{searchProgress}</p>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-phoenix-600 to-phoenix-400 loading-shimmer" />
            </div>
          </section>
        )}

        {/* Error */}
        {error && (
          <section className={`glass-card p-6 animate-slide-up ${
            error.includes('QUOTA_EXCEEDED') ? 'border-yellow-500/30' : 'border-red-500/30'
          }`}>
            {error.includes('QUOTA_EXCEEDED') ? (
              <div className="flex items-start gap-4">
                <div className="h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br from-yellow-500 to-orange-600 flex items-center justify-center text-xl shadow-lg">
                  🔑
                </div>
                <div>
                  <p className="font-bold text-yellow-300 text-lg mb-1">⚠️ Free Quota Exhausted</p>
                  <p className="text-gray-300 text-sm leading-relaxed">
                    Your free Gemini API key has reached its limit. Upgrade to a paid key for unlimited, faster, and more powerful AI features.
                  </p>
                  <div className="mt-3 bg-white/5 rounded-lg p-3 border border-white/10">
                    <p className="text-xs text-gray-400 mb-2">🚀 How to upgrade:</p>
                    <ol className="text-xs text-gray-300 space-y-1 list-decimal list-inside">
                      <li>Go to <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-phoenix-400 hover:text-phoenix-300 underline">Google AI Studio</a></li>
                      <li>Get a paid API key (Pay-as-you-go)</li>
                      <li>Replace <code className="text-phoenix-300 bg-white/10 px-1 rounded">GEMINI_API_KEY</code> in your <code className="text-phoenix-300 bg-white/10 px-1 rounded">.env</code> file</li>
                      <li>Restart the server</li>
                    </ol>
                  </div>
                  <button
                    className="mt-3 text-sm text-phoenix-400 hover:text-phoenix-300 underline"
                    onClick={handleSearch}
                  >
                    🔄 Retry Search
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <span className="text-2xl">⚠️</span>
                <div>
                  <p className="font-semibold text-red-300">Search Error</p>
                  <p className="text-sm text-gray-400 mt-1">{error}</p>
                  <button
                    className="mt-3 text-sm text-phoenix-400 hover:text-phoenix-300 underline"
                    onClick={handleSearch}
                  >
                    Retry Search
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Gemini Recommendation */}
        {results?.recommendation && (
          <section className="glass-card border-phoenix-500/30 p-6 sm:p-8 animate-slide-up">
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br from-sniper-500 to-sniper-700 flex items-center justify-center text-xl shadow-lg shadow-sniper-500/20">
                🧠
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-lg font-bold text-white">
                    Gemini AI Recommendation
                  </h3>
                  <span className="badge bg-phoenix-500/20 text-phoenix-300 border border-phoenix-500/30">
                    {Math.round(results.recommendation.confidence * 100)}%
                    confidence
                  </span>
                </div>
                <p className="text-xl font-semibold text-phoenix-300">
                  🏆 {results.recommendation.bestDeal}
                </p>
                <p className="text-gray-300 mt-2 leading-relaxed">
                  {results.recommendation.reasoning}
                </p>
                {results.recommendation.savingsEstimateCents > 0 && (
                  <p className="mt-3 text-green-400 font-semibold text-lg">
                    💰 Estimated savings: $
                    {(
                      results.recommendation.savingsEstimateCents / 100
                    ).toFixed(2)}
                  </p>
                )}
                {results.recommendation.riskFactors.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                      Risk Factors
                    </p>
                    <ul className="flex flex-wrap gap-2">
                      {results.recommendation.riskFactors.map((rf, i) => (
                        <li
                          key={i}
                          className="badge bg-yellow-500/10 text-yellow-300/80 border border-yellow-500/20 text-xs"
                        >
                          {rf}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {/* Smart Alternatives */}
            {results.alternatives && results.alternatives.length > 0 && (
              <div className="mt-6 pt-6 border-t border-white/10">
                <p className="text-sm text-phoenix-300 font-semibold mb-3 flex items-center gap-2">
                  <span>💡</span> Smart Alternatives to Consider:
                </p>
                <div className="flex flex-wrap gap-3">
                  {results.alternatives.map((alt, i) => (
                    <button
                      key={i}
                      className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 hover:border-phoenix-400/50 hover:bg-phoenix-500/10 transition-all text-sm text-gray-200 text-left"
                      onClick={() => {
                        setProductName(alt);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      {alt}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
        {/* Site Status */}
        {results?.siteResults && (
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 animate-fade-in">
            {results.siteResults.map((sr) => (
              <div
                key={sr.site}
                className={`glass-card p-4 ${sr.error && sr.productCount === 0 ? "border-red-500/20" : "border-green-500/20"}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span
                    className={
                      sr.site === "Amazon"
                        ? "badge-amazon"
                        : sr.site === "eBay"
                          ? "badge-ebay"
                          : "badge-walmart"
                    }
                  >
                    {sr.site}
                  </span>
                  <span className="text-xs text-gray-500 font-mono">
                    {(sr.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <p className="text-2xl font-bold text-white">
                  {sr.productCount}
                </p>
                <p className="text-xs text-gray-400">products found</p>
                {sr.error && (
                  <p className="text-xs text-red-400/80 mt-1 truncate">
                    {sr.error}
                  </p>
                )}
              </div>
            ))}
          </section>
        )}

        {/* Visual Price Comparison Card */}
        {sortedProducts.length > 0 && (() => {
          // Build per-site cheapest product (isolated computation)
          const siteMap: Record<string, { name: string; priceCents: number; source: string }> = {};
          for (const p of sortedProducts) {
            const key = p.source;
            if (!siteMap[key] || p.priceCents < siteMap[key].priceCents) {
              siteMap[key] = { name: p.name, priceCents: p.priceCents, source: p.source };
            }
          }
          const siteEntries = Object.values(siteMap);
          if (siteEntries.length < 2) return null;

          const maxPrice = Math.max(...siteEntries.map(s => s.priceCents));
          const cheapest = siteEntries.reduce((a, b) => a.priceCents < b.priceCents ? a : b);

          const siteColors: Record<string, { bar: string; text: string; bg: string }> = {
            Amazon: { bar: 'from-yellow-500 to-yellow-600', text: 'text-yellow-300', bg: 'bg-yellow-500/10' },
            eBay: { bar: 'from-blue-500 to-blue-600', text: 'text-blue-300', bg: 'bg-blue-500/10' },
            Walmart: { bar: 'from-green-500 to-green-600', text: 'text-green-300', bg: 'bg-green-500/10' },
          };

          return (
            <section className="glass-card p-6 animate-slide-up">
              <div className="flex items-center gap-2 mb-5">
                <span className="text-xl">🆚</span>
                <h3 className="text-lg font-bold text-white">Price Showdown</h3>
                <span className="text-xs text-gray-500 font-mono ml-auto">cheapest per site</span>
              </div>
              <div className="space-y-4">
                {siteEntries
                  .sort((a, b) => a.priceCents - b.priceCents)
                  .map((entry) => {
                    const colors = siteColors[entry.source] || siteColors.Amazon;
                    const width = Math.max(15, (entry.priceCents / maxPrice) * 100);
                    const isWinner = entry.source === cheapest.source;

                    return (
                      <div key={entry.source} className="group">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold ${colors.text}`}>{entry.source}</span>
                            {isWinner && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-phoenix-500 to-yellow-400 text-[10px] font-bold text-slate-900 shadow-sm">
                                ✅ Best Price
                              </span>
                            )}
                          </div>
                          <span className={`font-mono font-bold ${isWinner ? 'text-green-400 text-lg' : 'text-gray-300'}`}>
                            ${(entry.priceCents / 100).toFixed(2)}
                          </span>
                        </div>
                        <div className="h-3 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className={`h-full rounded-full bg-gradient-to-r ${colors.bar} transition-all duration-1000 ease-out ${isWinner ? 'shadow-lg' : 'opacity-60'}`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-gray-500 mt-1 truncate max-w-sm">
                          {entry.name}
                        </p>
                      </div>
                    );
                  })}
              </div>
            </section>
          );
        })()}
        {/* Data Quality Bar */}
        {results?.dataQuality && results.dataQuality.rawCount > results.dataQuality.cleanedCount && (
          <section className="glass-card p-4 animate-slide-up">
            <div className="flex items-center gap-3">
              <span className="text-xl">🧹</span>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-sm text-gray-300 font-medium">
                    Phoenix filtered{" "}
                    <span className="text-phoenix-400 font-bold">{results.dataQuality.rawCount}</span>{" "}
                    → <span className="text-green-400 font-bold">{results.dataQuality.cleanedCount}</span>{" "}
                    relevant products
                  </p>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    (results.dataQuality.cleanedCount / results.dataQuality.rawCount) >= 0.7
                      ? 'bg-green-500/20 text-green-300'
                      : (results.dataQuality.cleanedCount / results.dataQuality.rawCount) >= 0.4
                      ? 'bg-yellow-500/20 text-yellow-300'
                      : 'bg-red-500/20 text-red-300'
                  }`}>
                    {Math.round((results.dataQuality.cleanedCount / results.dataQuality.rawCount) * 100)}% relevance
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-phoenix-600 to-green-500 transition-all duration-1000"
                    style={{ width: `${Math.round((results.dataQuality.cleanedCount / results.dataQuality.rawCount) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Cache Hit Badge */}
        {(results as any)?.isCached && (
          <section className="glass-card border-green-500/30 p-3 animate-slide-up text-center">
            <span className="text-green-400 text-sm font-medium">⚡ Instant Cache Hit — Results from a previous identical search (0 tokens used)</span>
          </section>
        )}

        {/* Results Section */}
        {sortedProducts.length > 0 && (
          <section className="glass-card overflow-hidden animate-slide-up">
            <div className="px-4 sm:px-6 py-4 border-b border-white/10 flex items-center justify-between flex-wrap gap-3">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="text-phoenix-400">📦</span>
                {sortedProducts.length} Products Found
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setViewMode('cards')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${viewMode === 'cards' ? 'bg-phoenix-500/20 text-phoenix-300 border border-phoenix-500/30' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  🏷️ Cards
                </button>
                <button
                  onClick={() => setViewMode('table')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${viewMode === 'table' ? 'bg-phoenix-500/20 text-phoenix-300 border border-phoenix-500/30' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  📋 Table
                </button>
              </div>
            </div>

            {/* ─── Card Grid View ──────────────────────────────────── */}
            {viewMode === 'cards' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4 sm:p-6">
                {sortedProducts.map((product, idx) => {
                  const isBestDeal = results?.recommendation?.bestDeal?.toLowerCase() === product.name.toLowerCase();
                  return (
                    <div
                      key={idx}
                      className={`rounded-2xl border p-4 transition-all hover:scale-[1.02] ${
                        isBestDeal
                          ? 'border-phoenix-500/40 bg-gradient-to-br from-phoenix-500/10 to-yellow-500/5 shadow-lg shadow-phoenix-500/10'
                          : 'border-white/10 bg-white/[.02] hover:border-white/20'
                      }`}
                    >
                      {/* Card Header */}
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex-1 min-w-0">
                          {isBestDeal && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-phoenix-500 to-yellow-400 text-[10px] font-bold text-slate-900 shadow-sm mb-2">
                              ✨ Phoenix Choice
                            </span>
                          )}
                          <p className="text-white font-medium text-sm line-clamp-2">
                            {product.name}
                          </p>
                        </div>
                        <span className={product.source === 'Amazon' ? 'badge-amazon' : product.source === 'eBay' ? 'badge-ebay' : 'badge-walmart'}>
                          {product.source}
                        </span>
                      </div>

                      {/* Price & Rating */}
                      <div className="flex items-end justify-between mb-3">
                        <div>
                          <p className="text-2xl font-bold text-green-400 font-mono">
                            {product.priceDisplay}
                          </p>
                          {isBestDeal && (
                            <span className="text-[10px] bg-green-500/20 text-green-300 px-1.5 py-0.5 rounded font-medium">
                              🏷️ Coupon: PHOENIX5 (-5%)
                            </span>
                          )}
                        </div>
                        {product.rating != null && (
                          <div className="text-right">
                            <p className="text-yellow-400 text-sm">
                              {'★'.repeat(Math.round(product.rating))}
                              {'☆'.repeat(5 - Math.round(product.rating))}
                            </p>
                            <p className="text-[10px] text-gray-500">{product.rating.toFixed(1)}/5</p>
                          </div>
                        )}
                      </div>

                      {/* Sentiment Tags */}
                      {product.sentimentTags && product.sentimentTags.length > 0 && (
                        <div className="flex gap-1.5 flex-wrap mb-3">
                          {product.sentimentTags.map((tag, i) => (
                            <span
                              key={i}
                              className={`sentiment-bubble ${
                                tag.toLowerCase().includes('risk') || tag.toLowerCase().includes('bad')
                                  ? 'bg-red-500/10 text-red-300 border-red-500/30'
                                  : tag.toLowerCase().includes('good') || tag.toLowerCase().includes('great') || tag.toLowerCase().includes('premium')
                                  ? 'bg-green-500/10 text-green-300 border-green-500/30'
                                  : 'bg-sniper-500/10 text-sniper-300 border-sniper-500/30'
                              }`}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-2 border-t border-white/5">
                        {product.url && (
                          <a
                            href={product.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 text-center text-xs py-1.5 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 transition-colors"
                          >
                            🔗 Visit Site
                          </a>
                        )}
                        <button
                          className="flex-1 text-center text-xs py-1.5 rounded-lg bg-phoenix-500/10 text-phoenix-300 hover:bg-phoenix-500/20 transition-colors font-medium"
                          onClick={() => setCheckoutProduct({ productName: product.name, priceCents: product.priceCents })}
                        >
                          🪄 Delegate Phoenix
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ─── Table View ──────────────────────────────────────── */}
            {viewMode === 'table' && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5 text-xs text-gray-400 uppercase tracking-wider">
                    <th className="px-6 py-3 text-left">#</th>
                    <th className="px-6 py-3 text-left">Product</th>
                    <th
                      className="px-6 py-3 text-left cursor-pointer hover:text-phoenix-400 transition-colors"
                      onClick={() => handleSort("price")}
                    >
                      Price{" "}
                      {sortBy === "price" ? (sortAsc ? "↑" : "↓") : ""}
                    </th>
                    <th
                      className="px-6 py-3 text-left cursor-pointer hover:text-phoenix-400 transition-colors"
                      onClick={() => handleSort("rating")}
                    >
                      Rating{" "}
                      {sortBy === "rating" ? (sortAsc ? "↑" : "↓") : ""}
                    </th>
                    <th
                      className="px-6 py-3 text-left cursor-pointer hover:text-phoenix-400 transition-colors"
                      onClick={() => handleSort("source")}
                    >
                      Source{" "}
                      {sortBy === "source" ? (sortAsc ? "↑" : "↓") : ""}
                    </th>
                    <th className="px-6 py-3 text-left">Link</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProducts.map((product, idx) => {
                    const isBestDeal = results?.recommendation?.bestDeal?.toLowerCase() === product.name.toLowerCase();
                    return (
                    <tr
                      key={idx}
                      className={`border-b border-white/5 transition-colors ${
                        isBestDeal ? 'best-deal-row' : 'hover:bg-white/[.03]'
                      }`}
                    >
                      <td className="px-4 sm:px-6 py-4 text-gray-500 font-mono text-sm">
                        {idx + 1}
                      </td>
                      <td className="px-4 sm:px-6 py-4">
                        <div className="flex items-center gap-2 mb-1.5">
                          <p className="text-white font-medium text-sm max-w-xs truncate">
                            {product.name}
                          </p>
                          {isBestDeal && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-phoenix-500 to-yellow-400 text-[10px] font-bold text-slate-900 shadow-sm animate-pulse">
                              ✨ Phoenix Choice
                            </span>
                          )}
                        </div>
                        {product.sentimentTags && product.sentimentTags.length > 0 && (
                          <div className="flex gap-1.5 flex-wrap">
                            {product.sentimentTags.map((tag, i) => (
                              <span
                                key={i}
                                className={`sentiment-bubble ${
                                  tag.toLowerCase().includes('risk') || tag.toLowerCase().includes('bad') || tag.toLowerCase().includes('poor')
                                    ? 'bg-red-500/10 text-red-300 border-red-500/30 hover:bg-red-500/20 min-w-max'
                                    : tag.toLowerCase().includes('good') || tag.toLowerCase().includes('great') || tag.toLowerCase().includes('best') || tag.toLowerCase().includes('premium')
                                    ? 'bg-green-500/10 text-green-300 border-green-500/30 hover:bg-green-500/20 min-w-max'
                                    : 'bg-sniper-500/10 text-sniper-300 border-sniper-500/30 hover:bg-sniper-500/20 min-w-max'
                                }`}
                                style={{ animationDelay: `${i * 100}ms` }}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 sm:px-6 py-4">
                        <span className="text-green-400 font-semibold font-mono">
                          {product.priceDisplay}
                        </span>
                      </td>
                      <td className="px-4 sm:px-6 py-4">
                        {product.rating != null ? (
                          <span className="text-yellow-400 text-sm">
                            {"★".repeat(Math.round(product.rating))}
                            {"☆".repeat(5 - Math.round(product.rating))}{" "}
                            <span className="text-gray-500 ml-1">
                              {product.rating.toFixed(1)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 sm:px-6 py-4">
                        <span
                          className={
                            product.source === "Amazon"
                              ? "badge-amazon"
                              : product.source === "eBay"
                                ? "badge-ebay"
                                : "badge-walmart"
                          }
                        >
                          {product.source}
                        </span>
                      </td>
                      <td className="px-4 sm:px-6 py-4">
                        <div className="flex items-center gap-2 flex-wrap">
                        {product.url && (
                          <a
                            href={product.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-400 hover:text-white text-xs transition-colors"
                          >
                            🔗 Visit Site
                          </a>
                        )}
                        <button
                          className="magic-buy-btn group"
                          onClick={() => setCheckoutProduct({ productName: product.name, priceCents: product.priceCents })}
                        >
                          <span className="group-hover:animate-ping absolute right-0 top-0 h-2 w-2 rounded-full bg-white opacity-75"></span>
                          🪄 Delegate Phoenix
                        </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </section>
        )}

        {/* Search History */}
        {history && history.length > 0 && (
          <section className="glass-card p-6 sm:p-8 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="text-sniper-400">📜</span> Search History
              </h3>
              <button
                onClick={async () => {
                  if (confirm("Clear search history?")) {
                    await clearHistoryMutation.mutateAsync();
                    historyQuery.refetch();
                    statsQuery.refetch();
                  }
                }}
                className="p-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-all flex items-center justify-center text-xs"
                title="Clear History"
              >
                🗑️ Clear
              </button>
            </div>
            <div className="space-y-3">
              {history.map((s: any) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-xl bg-white/[.03] border border-white/5 px-4 py-3 hover:border-phoenix-500/20 transition-all"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium text-sm truncate">
                      {s.productName}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {s.category} ·{" "}
                      {new Date(s.createdAt).toLocaleString()} ·{" "}
                      <span
                        className={
                          s.status === "completed"
                            ? "text-green-400"
                            : s.status === "failed"
                              ? "text-red-400"
                              : "text-yellow-400"
                        }
                      >
                        {s.status}
                      </span>
                    </p>
                  </div>
                  <button
                    className="btn-sniper text-xs px-3 py-1.5 ml-4"
                    onClick={() => handleRerun(s.id)}
                    disabled={isSearching}
                  >
                    🔄 Re-run
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Agent UI Overlays ──────────────────────────────────────── */}
        
        {/* Favorite Toast Overlays */}
        {favoriteToast && (
          <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-surface-800 border-2 border-phoenix-500 rounded-full px-6 py-3 shadow-2xl shadow-phoenix-500/20 text-white font-medium animate-scale-in flex items-center gap-3">
            <span className="text-2xl animate-pulse">❤️</span> {favoriteToast}
          </div>
        )}

        {/* Negotiation Simulation Modal */}
        {checkoutProduct && (() => {
          // Isolated negotiation state using a self-contained IIFE + effect-like pattern
          const NegotiationModal = () => {
            const [phase, setPhase] = useState(0);
            const [showConfetti, setShowConfetti] = useState(false);

            const phases = [
              { icon: "🌐", title: "Opening Website...", desc: "Phoenix is navigating to the store page" },
              { icon: "🛒", title: "Adding to Cart...", desc: "Phoenix found the item and is adding it" },
              { icon: "🔍", title: "Scanning for Coupons...", desc: "Searching for active promo codes and discounts" },
              { icon: "🏷️", title: "Coupon Applied!", desc: "Found PHOENIX2026 — saving you an extra 5%!" },
              { icon: "🎉", title: "Ready to Checkout!", desc: "Best deal secured. Awaiting your final approval." },
            ];

            useEffect(() => {
              const timers: NodeJS.Timeout[] = [];
              for (let i = 1; i < phases.length; i++) {
                timers.push(setTimeout(() => setPhase(i), i * 2500));
              }
              timers.push(setTimeout(() => setShowConfetti(true), phases.length * 2500));
              return () => timers.forEach(t => clearTimeout(t));
            }, []);

            return (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
                <div className="bg-gradient-to-br from-surface-800 to-surface-900 border border-phoenix-500/30 rounded-3xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden animate-scale-in">
                  {/* Top bar */}
                  <div className="absolute top-0 left-0 w-full h-1.5 bg-white/5 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-phoenix-500 to-green-500 transition-all duration-1000 ease-out"
                      style={{ width: `${((phase + 1) / phases.length) * 100}%` }}
                    />
                  </div>

                  {/* Confetti Effect */}
                  {showConfetti && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                      {Array.from({ length: 30 }).map((_, i) => (
                        <div
                          key={i}
                          className="absolute w-2 h-2 rounded-sm"
                          style={{
                            left: `${Math.random() * 100}%`,
                            backgroundColor: ['#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#8B5CF6'][i % 5],
                            animation: `confetti-fall ${1.5 + Math.random() * 2}s ease-out forwards`,
                            animationDelay: `${Math.random() * 0.5}s`,
                          }}
                        />
                      ))}
                    </div>
                  )}

                  <div className="text-center relative z-10">
                    {/* Animated Icon */}
                    <div className="w-20 h-20 mx-auto mb-4 relative">
                      <div className="w-20 h-20 bg-phoenix-500/20 rounded-full flex items-center justify-center">
                        <span className="text-4xl transition-all duration-500">{phases[phase].icon}</span>
                      </div>
                      <div className="absolute inset-0 border-4 border-transparent border-t-phoenix-400 rounded-full animate-spin" />
                    </div>

                    <h3 className="text-2xl font-bold text-white mb-1 transition-all duration-500">{phases[phase].title}</h3>
                    <p className="text-gray-400 text-sm mb-6">{phases[phase].desc}</p>

                    {/* Product Info */}
                    <div className="bg-surface-950 rounded-xl p-4 mb-6 border border-white/5 text-left shadow-inner">
                      <p className="text-sm font-semibold text-gray-200 line-clamp-2 mb-2">
                        {checkoutProduct.productName}
                      </p>
                      <div className="flex items-center gap-2">
                        <p className="text-2xl font-bold text-green-400">
                          ${(checkoutProduct.priceCents / 100).toFixed(2)}
                        </p>
                        {phase >= 3 && (
                          <span className="text-xs bg-green-500/20 text-green-300 px-2 py-0.5 rounded-full font-medium animate-pulse">
                            -5% coupon applied
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Phase Steps */}
                    <div className="space-y-2 mb-6 text-sm text-left">
                      {phases.map((p, i) => (
                        <div key={i} className={`flex items-center gap-3 transition-all duration-500 ${i > phase ? 'opacity-30' : ''}`}>
                          <div className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[10px] ${
                            i < phase ? 'bg-green-500 text-white' :
                            i === phase ? 'bg-phoenix-500 text-white animate-pulse' :
                            'border-2 border-gray-600'
                          }`}>
                            {i < phase ? '✓' : i === phase ? '•' : ''}
                          </div>
                          <span className={i <= phase ? 'text-gray-200' : 'text-gray-600'}>{p.title}</span>
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => setCheckoutProduct(null)}
                      className="w-full btn-phoenix py-3 rounded-xl font-bold text-white"
                    >
                      {phase >= phases.length - 1 ? '✅ Approve & Close' : 'Cancel Automation'}
                    </button>
                    <p className="text-[10px] text-gray-500 mt-4 uppercase tracking-widest">
                      (Demonstration Mode)
                    </p>
                  </div>
                </div>
              </div>
            );
          };
          return <NegotiationModal />;
        })()}

        {/* Footer */}
        <footer className="text-center py-8 text-xs text-gray-600">
          <p>
            Phoenix Shopping Sniper · Google Gemini Live Agent Challenge ·{" "}
            {new Date().getFullYear()}
          </p>
          <p className="mt-1">
            Built with Gemini 2.5 Flash · Phoenix Engine v11 · React · tRPC
          </p>
        </footer>

        {/* AI Chatbot */}
        {results?.searchId && <Chatbot searchId={results.searchId} onAction={handleAgentAction} />}
      </main>
    </div>
  );
}
