# Phoenix Shopping Sniper 🎯


![photo_2026-03-12_18-01-09](https://github.com/user-attachments/assets/49a45465-a95a-4676-b0e6-c168400124eb)




> AI-powered shopping price comparison using **Google Gemini** and autonomous browser automation — built for the **Google Gemini Live Agent Challenge**.

## ✨ Features

- **Interactive AI Questionnaire** — Phoenix AI Consultant asks targeted questions *before* searching to perfectly match your needs
- **Multi-Site Search** — Compares prices across Amazon, eBay, and Walmart simultaneously
- **Visual Product Cards & Analytics** — Beautiful, responsive grid view with live saving statistics and automated coupon discovery
- **Gemini AI Analysis** — Uses `gemini-2.5-flash` for sentiment analysis, smart alternatives, and deal recommendations
- **Phoenix Engine v11** — Autonomous browser automation with SoM (Set-of-Mark) visual tagging
- **Real-Time Progress** — Live search status with animated narration
- **Search History & Favorites** — Re-run previous searches with one click

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    React Frontend (Vite)                  │
│  Sniper.tsx → tRPC Client → React Query                  │
├──────────────────────────────────────────────────────────┤
│                Express + tRPC Backend                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │ Sniper       │  │ Gemini       │  │ Phoenix       │   │
│  │ Router       │→ │ Integration  │  │ Engine        │   │
│  │ (5 procs)   │  │ (CB + stream)│  │ (subprocess)  │   │
│  └──────┬──────┘  └──────────────┘  └───────────────┘   │
│         │                                                 │
│  ┌──────▼──────┐  ┌──────────────┐                       │
│  │ SQLite DB   │  │ GCS Storage  │                       │
│  │ (Drizzle)   │  │ (fallback)   │                       │
│  └─────────────┘  └──────────────┘                       │
└──────────────────────────────────────────────────────────┘
```

## 🛠️ Tech Stack

| Layer       | Technology                                    |
|-------------|-----------------------------------------------|
| AI          | Google Gemini 2.0 Flash (via @google/generativeai) |
| Automation  | Phoenix Engine v11 (Python + Playwright)      |
| Frontend    | React 18 + Tailwind CSS + Vite                |
| API         | tRPC v11 + Express                            |
| Database    | SQLite + Drizzle ORM                          |
| Storage     | Google Cloud Storage (with local fallback)    |
| Language    | TypeScript (full-stack) + Python (engine)     |

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Python 3.10+
- Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey))

### 1-Minute Setup & Run

1. **Configure Environment:** Create a `.env` in the root folder:
   ```env
   GEMINI_API_KEY=your-gemini-api-key
   # Optional: GCS_BUCKET_NAME, GCS_PROJECT_ID, GCS_CREDENTIALS_PATH
   ```
2. **Install & Start:**
   ```bash
   chmod +x setup.sh run.sh
   ./setup.sh
   ./run.sh
   ```
3. **Open:** Navigate to [http://localhost:5173/sniper](http://localhost:5173/sniper).

## 📁 Project Structure

```
├── client/src/
│   ├── pages/Sniper.tsx      # Shopping UI
│   ├── utils/trpc.ts         # tRPC client
│   ├── App.tsx               # React routing
│   └── index.css             # Tailwind + glass design
├── server/
│   ├── index.ts              # Express server
│   ├── trpc.ts               # tRPC init
│   ├── routers.ts            # Router aggregation
│   ├── routers/sniper.ts     # 5 tRPC procedures
│   ├── db.ts                 # Drizzle ORM CRUD
│   ├── gemini_integration.ts # Gemini API + circuit breaker
│   ├── phoenix_engine.ts     # Python subprocess wrapper
│   └── storage.ts            # GCS + local fallback
├── drizzle/schema.ts         # Database schema
├── ui_navigator/             # Python Phoenix Engine
└── setup.sh / run.sh         # Automation scripts
```

## 🔒 Error Isolation

- **Gemini failures** → Circuit breaker (3 fails → 30s heuristic fallback)
- **GCS failures** → Transparent local file storage fallback
- **Phoenix Engine crashes** → Per-site circuit breaker (5 attempts max)
- **Database errors** → Caught and logged, never crash the app

## 🚀 Future Revolutionary Features (Roadmap)
1. **1-Click AI Auto-Buy Checkout**: Connect user accounts so the Agent can autonomously navigate the store, solve captchas, add to cart, and complete purchases entirely in the background.
2. **Automated Negotiation Bot**: AI agent that interacts with eBay sellers in real-time, sending counter-offers for used items based on your max budget.
3. **Visual Object Search via Webcam**: Point your camera at an item, and Phoenix will instantly identify it and find the cheapest global seller.
4. **Predictive Price Forecasting AI**: Analyzes historical market data to predict flash sales, advising the user: *"Wait 3 days, probability of a 15% discount is very high!"*
5. **Cross-Border "Smuggler" Routing API**: The AI autonomously calculates the absolute cheapest shipping pathways utilizing third-party global forwarders instead of direct shipping.

## 📜 License

MIT
