/**
 * server/routers/chat.ts — tRPC router for the Conversational Shopping Agent.
 *
 * Provides a context-aware chat interface for discussing search results.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { getSearchResults } from "../db.js";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

// ── Module Logger ───────────────────────────────────────────────────
const LOG_PREFIX = "[chat]";
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${LOG_PREFIX} ${level}: ${msg}`);
}

// ── Input Schema ────────────────────────────────────────────────────
const chatInput = z.object({
  searchId: z.number().positive(),
  message: z.string().min(1).max(1000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "model"]),
        text: z.string(),
      })
    )
    .default([]),
});

export const chatRouter = router({
  /**
   * sendMessage — Processes a user chat message with context of their current search results.
   */
  sendMessage: protectedProcedure
    .input(chatInput)
    .mutation(async ({ input }) => {
      try {
        const apiKey = process.env.GEMINI_API_KEY?.trim();
        if (!apiKey) {
          throw new Error("GEMINI_API_KEY is not configured.");
        }

        // Fetch products as context
        const products = await getSearchResults(input.searchId, "price");
        if (!products || products.length === 0) {
          throw new Error("No products found for this search context.");
        }

        // Build product context string
        const productContextList = products
          .slice(0, 15) // Limit context to top 15 to save tokens
          .map(
            (p, i) =>
              `${i + 1}. [${p.source}] ${p.productName} - $${(
                p.priceCents / 100
              ).toFixed(2)}` +
              (p.rating ? ` (Rating: ${p.rating})` : "") +
              (p.sentimentTags && p.sentimentTags.length > 0
                ? ` [Tags: ${p.sentimentTags.join(", ")}]`
                : "")
          )
          .join("\n");

        // Deduplicate and fetch screenshot URLs to pass as Vision context
        const screenshotUrls = Array.from(
          new Set(
            products
              .slice(0, 15)
              .map((p) => p.screenshotUrl)
              .filter((url): url is string => !!url)
          )
        );

        const imageParts: any[] = [];
        for (const url of screenshotUrls) {
          try {
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const arrayBuffer = await resp.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            imageParts.push({
              inlineData: {
                data: buffer.toString("base64"),
                mimeType: "image/jpeg",
              },
            });
          } catch (err) {
            log("WARNING", `Failed to fetch screenshot for chat context: ${err}`);
          }
        }

        const systemInstruction = `You are a helpful, expert AI shopping assistant built into the "Phoenix Shopping Sniper" app.
The user is viewing the results of their most recent search. You must answer their questions based ONLY on the products listed below. 
Do not hallucinate products or prices. If they ask for the cheapest, fastest, or best, use the provided list.
Keep your answers brief, friendly, and highly conversational. Use emojis. If a product seems like a scam or fake, warn them.

CURRENT SEARCH RESULTS CONTEXT (Top 15 sorted by price):
${productContextList}`;

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: "gemini-2.5-flash",
          systemInstruction,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "initiateCheckout",
                  description: "Initiates a simulated checkout process for a specific product. Call this when the user asks to buy or purchase a product.",
                  parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                      productName: {
                        type: SchemaType.STRING,
                        description: "The name of the product to purchase",
                      },
                      priceCents: {
                        type: SchemaType.INTEGER,
                        description: "The price of the product in cents",
                      },
                    },
                    required: ["productName", "priceCents"],
                  },
                },
                {
                  name: "addToFavorites",
                  description: "Adds a specific product to the user's favorites list. Call this when the user asks to save, favorite, or remember a product.",
                  parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                      productName: {
                        type: SchemaType.STRING,
                        description: "The name of the product to favorite",
                      },
                    },
                    required: ["productName"],
                  },
                },
              ],
            },
          ],
        });

        const formattedHistory = input.history.map((msg, index) => {
          if (index === 0 && msg.role === "user" && imageParts.length > 0) {
            return {
              role: msg.role,
              parts: [{ text: msg.text }, ...imageParts],
            };
          }
          return {
            role: msg.role,
            parts: [{ text: msg.text }],
          };
        });

        const chat = model.startChat({
          history: formattedHistory,
        });

        const messageParts: any[] = [{ text: input.message }];
        // If history is empty, attach images to the first real user message
        if (input.history.length === 0 && imageParts.length > 0) {
          messageParts.push(...imageParts);
        }

        log("INFO", `Answering chat for search #${input.searchId} (with ${imageParts.length} SoM images)`);
        const result = await chat.sendMessage(messageParts);
        
        let responseText = "";
        const parts = result.response.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.text) responseText += p.text;
        }

        const actions: any[] = [];
        const functionCalls = result.response.functionCalls();
        if (functionCalls) {
          for (const call of functionCalls) {
            actions.push({
              name: call.name,
              args: call.args,
            });
          }
          if (!responseText) {
            responseText = "I'm executing that action for you right now! 🚀";
          }
        }

        return {
          text: responseText,
          actions,
        };
      } catch (err: any) {
        const errMsg = String(err?.message || err);
        log("ERROR", `sendMessage failed: ${errMsg}`);

        // Detect quota / rate limit errors
        if (
          errMsg.includes("429") ||
          errMsg.toLowerCase().includes("quota") ||
          errMsg.toLowerCase().includes("rate limit") ||
          errMsg.toLowerCase().includes("resource has been exhausted")
        ) {
          return {
            text: "⚠️ **Free Quota Exhausted!**\n\nYour free Gemini API key has reached its limit.\n\n🚀 **How to upgrade:**\n1. Go to [Google AI Studio](https://aistudio.google.com/apikey)\n2. Get a paid API key (Pay-as-you-go)\n3. Replace `GEMINI_API_KEY` in your `.env` file\n4. Restart the server\n\nOnce upgraded, you'll enjoy the full Phoenix experience with no limits! 💪",
            actions: [],
          };
        }

        throw new Error(`Chat error: ${errMsg}`);
      }
    }),
});
