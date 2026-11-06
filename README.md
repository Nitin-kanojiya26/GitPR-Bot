# Vigilentia: Autonomous AI Pull Request Reviewer

<div align="center">

[![Install App](https://img.shields.io/badge/GitHub_App-Install_Vigilentia-2ea44f?style=for-the-badge&logo=github)](https://github.com/apps/vigilentia)

### [🚀 Open Live Dashboard & Settings](https://gitpr-bot.onrender.com) &bull; [📦 Install on Your GitHub Repositories](https://github.com/apps/gitpr-bot)

</div>

---

## The Problem

Code reviews are one of the biggest bottlenecks in modern engineering teams:
- **Review Fatigue:** Senior engineers spend hours reviewing boilerplate, missing subtle security flaws (like raw `eval()`, unhandled promises, or missing network timeouts).
- **Style Guide Decay:** Teams write comprehensive 20-page engineering guidelines that get forgotten because nobody memorizes every rule.
- **Generic AI Bots Fail:** Typical AI review bots hallucinate invalid line numbers (triggering GitHub HTTP 422 errors), lack knowledge of company-specific guidelines, or timeout on GitHub's strict 10-second webhook limit.

**Vigilentia** is engineered from the ground up to solve these problems without heavy, black-box AI frameworks. Every line of parsing, embedding, retrieval, queuing, and posting is modular, transparent, and strictly validated.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph GitHub ["GitHub Infrastructure"]
        PR["Developer Opens / Updates PR"] --> WH["GitHub Webhook Delivery"]
        GH_API["GitHub REST API (octokit)"]
    end

    subgraph Ingestion ["Ingestion Layer (src/index.ts)"]
        WH -->|"Signed Webhook"| PROBOT["Probot Handler"]
        PROBOT -->|"1. Instant HTTP 200 OK (under 15ms)"| WH
        PROBOT -->|"2. Enqueue Review Job"| QUEUE["BullMQ (pr-reviews)"]
    end

    subgraph QueueLayer ["Async Queue & Idempotency (src/queue/)"]
        QUEUE --> REDIS[("Redis Cache & Queue (Port 6380)")]
        REDIS -->|"SET ... NX EX"| LOCK["Idempotency Lock (Deduplication)"]
        REDIS --> WORKER["BullMQ Worker (concurrency: 2)"]
    end

    subgraph ReviewPipeline ["Review & RAG Pipeline (src/review/)"]
        WORKER --> FETCH["Fetch Changed Files (octokit)"]
        FETCH --> FILTER["File Filtering (skip lockfiles, binaries, dist)"]
        FILTER --> NUMBER["Numbered Diff (Line Numbers) & Legal Line Set"]
        
        NUMBER --> RAG_EMBED["Embed Diff Summary (gemini-embedding-001)"]
        RAG_EMBED --> PG[("PostgreSQL 16 + pgvector (Port 5433)")]
        PG -->|"Cosine Distance Vector Search"| TOP_RULES["Retrieve Top 3 Style Rules"]
        
        TOP_RULES --> PROMPT["Ground Prompt (Diff + Style Rules)"]
        PROMPT --> GEMINI["Google Gemini 2.5 Flash"]
        GEMINI --> ZOD["Zod Schema Validation & Retry Defense"]
        ZOD --> DEFENSE["Hallucination Defense (Drop Out-of-Diff Lines)"]
        DEFENSE --> POST["Post Line-Level Review Comments"]
    end

    POST --> GH_API
```

---

## Key Features

### 1. Semantic RAG with `pgvector` & Style Guide Grounding
- Parses [`docs/style-guide.md`](docs/style-guide.md) into discrete rule chunks.
- Computes **768-dimensional mathematical embeddings** via `gemini-embedding-001` and stores them in PostgreSQL with `pgvector`.
- On every PR, the bot computes the vector embedding of the incoming code diff and executes an in-database cosine distance query (`<=>` operator) to retrieve the top 3 most relevant rules.
- Gemini is instructed to explicitly cite the exact rule title in its review comments (e.g. `[Rule: 1. Network Requests Must Have Timeouts]`).

### 2. Hallucination Defense & Line-Accurate Comments
- Uses `parse-diff` to extract legal line numbers on the `RIGHT` side of the diff.
- Prefixes every line in the prompt with `L<number>: + <content>` so the LLM never miscounts lines.
- Drops any comment referencing a line not present in the legal diff set, completely preventing GitHub HTTP 422 errors.

### 3. Asynchronous Queue Architecture (BullMQ + Redis)
- Responds to GitHub's webhook in **under 15 milliseconds** with `HTTP 200 OK`, completely eliminating webhook timeout failures.
- Offloads diff analysis, vector embedding, and LLM calls to background worker queues.
- Configured with `concurrency: 2` and automatic exponential backoff retry to respect Gemini API rate limits.

### 4. Distributed Idempotency
- Uses atomic Redis locks via `SET pr-review-lock:{owner}:{repo}:{pr}:{sha} locked EX 300 NX`.
- Prevents duplicate review comments when GitHub retries webhooks or when developers push rapid consecutive commits.

### 5. Deep Production Healthchecks (`/healthz`)
- `/healthz` endpoint performs active diagnostic probes against both PostgreSQL (`SELECT 1;`) and Redis (`PING`).
- Returns `HTTP 200` with latency telemetry when all services are healthy, or `HTTP 503` if any dependency degrades.

### 6. Containerized with Dev/Prod Parity
- Multi-stage production `Dockerfile` based on `node:20-alpine` running as non-root user `node`.
- Declarative [`docker-compose.yml`](docker-compose.yml) orchestrating the bot, `pgvector/pgvector:pg16`, and `redis:7-alpine`.

---

## Tech Stack

| Component | Technology | Purpose |
|---|---|---|
| **Runtime** | Node.js 20+ (TypeScript) | Strict null checks, modern ES modules |
| **GitHub App Framework** | Probot v14 / Octokit | Webhook signature verification, JWT token exchange |
| **Diff Engine** | `parse-diff` | Unified diff parsing, hunk extraction |
| **Generative LLM** | Google Gemini 2.5 Flash | High-speed, structured JSON code review |
| **Embedding Model** | `gemini-embedding-001` | 768-dimensional semantic code vectorization |
| **Vector Database** | PostgreSQL 16 + `pgvector` | In-database cosine similarity search (`<=>`) |
| **Queue & Cache** | BullMQ + Redis | Background job processing and atomic distributed locks |
| **Schema Validation** | Zod | Runtime validation for LLM outputs |
| **Web UI & Multi-Tenancy** | Express 5, EJS, Chart.js | Minimalist black dashboard, BYOK settings, multi-tenant isolation |
| **Data Protection** | AES-256-GCM (node:crypto) | Encryption of tenant Gemini keys with unique 96-bit IVs |
| **Unit Testing** | Vitest | Comprehensive suite (126 passing tests across 19 suites) |
| **Containerization** | Docker & Docker Compose | Multi-stage image build and service orchestration |

---

## Directory Structure

```
vigilentia/
├── db/
│   └── migrations/
│       └── 001_initial_schema.sql  # Multi-tenant PostgreSQL schema with pgvector
├── docs/
│   └── style-guide.md        # Default style guide rules enforced by the bot
├── evals/
│   ├── cases.json            # Labeled test diffs for benchmarking retrieval
│   └── eval-rag.js           # RAG evaluation script measuring Hit Rate @ 3
├── public/
│   └── css/
│       └── style.css         # Minimalist black design system & Inter typography
├── src/
│   ├── dashboard/            # 4-panel analytics: volume, top rules, outcome ratios
│   │   ├── routes.ts
│   │   └── service.ts
│   ├── db/
│   │   ├── client.ts         # PostgreSQL pg pool & query helper
│   │   └── migrate.ts        # Atomic schema migration runner
│   ├── installations/        # Multi-tenant installation & rule sync service
│   │   └── service.ts
│   ├── queue/                # Asynchronous queue & worker pipeline
│   │   ├── delivery.ts       # Webhook delivery deduplication
│   │   ├── idempotency.ts    # Redis distributed atomic locks
│   │   ├── reviewQueue.ts    # BullMQ queue configuration
│   │   └── worker.ts         # BullMQ background review worker
│   ├── review/               # AI review engine & pgvector RAG
│   │   ├── diff.ts           # Numbered diffs & legal line number calculations
│   │   ├── embed.ts          # 768-D code embedding via gemini-embedding-001
│   │   ├── filters.ts        # File filtering & smart outdated comment deduplication
│   │   ├── github.ts         # Octokit review comment posting wrapper
│   │   ├── learner.ts        # Feedback learning from thread resolutions
│   │   ├── llm.ts            # Gemini 2.5 client, Zod schemas, auto-retry
│   │   ├── outcomes.ts       # Fixed vs ignored resolution tracking
│   │   ├── persistence.ts    # Review & comment audit persistence
│   │   ├── rag.ts            # pgvector semantic rule retriever
│   │   └── reviewPR.ts       # Main review orchestrator
│   ├── security/             # AES-256-GCM BYOK encryption & decryption
│   │   └── crypto.ts
│   ├── settings/             # BYOK key management & custom style guide editor
│   │   ├── routes.ts
│   │   └── service.ts
│   ├── web/                  # Express web application, GitHub OAuth & CSRF
│   │   ├── app.ts
│   │   ├── auth.ts
│   │   └── csrf.ts
│   ├── env.ts                # Synchronous environment bootstrap & sanitization
│   ├── health.ts             # Healthcheck service & HTTP handler (/healthz)
│   └── index.ts              # Probot entrypoint & webhook router
├── test/                     # 19 Vitest test suites (126 tests)
│   ├── auth.test.ts          # Multi-tenant auth & OAuth callback tests
│   ├── crypto.test.ts        # AES-256-GCM encryption tests
│   ├── dashboard.test.ts     # Analytics metrics & outcome rate tests
│   ├── diff.test.ts          # Diff parsing & legal line calculation tests
│   ├── filters.test.ts       # File filters & outdated comment tests
│   ├── guide.test.ts         # Markdown rule parsing & RAG retrieval tests
│   ├── health.test.ts        # Deep /healthz dependency probe tests
│   ├── idempotency.test.ts   # Redis atomic lock tests
│   ├── installation.test.ts  # Multi-tenant tenant initialization tests
│   ├── isolation.test.ts     # Multi-tenant isolation & security audit tests
│   ├── learner.test.ts       # Review resolution learning tests
│   ├── llm.test.ts           # Zod schema validation & prompt generation tests
│   ├── migrate.test.ts       # Database migration runner tests
│   ├── outcomes.test.ts      # Comment resolution rate calculation tests
│   ├── persistence.test.ts   # Review audit log persistence tests
│   ├── rag.test.ts           # Cosine similarity vector search tests
│   ├── reliability.test.ts   # Queue resilience & backoff tests
│   ├── settings.test.ts      # BYOK rate limit & key verification tests
│   └── web.test.ts           # Express routing & reverse proxy trust tests
├── views/                    # Responsive EJS views with dark mode aesthetic
│   ├── partials/             # Header, footer, and navigation
│   ├── dashboard.ejs         # 4-panel interactive Chart.js analytics
│   ├── index.ejs             # Product landing page
│   ├── privacy.ejs           # Data protection & encryption privacy policy
│   └── settings.ejs          # BYOK key & live style guide editor
├── .dockerignore             # Protects credentials and secrets from Docker builds
├── docker-compose.yml        # Orchestration for bot, postgres-pgvector, and redis
├── Dockerfile                # Multi-stage production container build
├── package.json              # NPM dependencies and scripts
├── render.yaml               # Infrastructure-as-Code for Render deployment
└── tsconfig.json             # TypeScript compiler configuration
```

---

## Getting Started

### Prerequisites
- **Node.js:** v20.x or higher
- **Docker Desktop:** Installed and running
- **GitHub App:** Registered with `pull_request` webhook permission
- **Google AI Studio API Key:** For Gemini 2.5 Flash and embeddings

---

### Step 1: Clone & Install Dependencies

```bash
git clone https://github.com/Nitin-kanojiya26/vigilentia.git
cd vigilentia
npm install
```

---

### Step 2: Configure Environment Variables

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Fill in your configuration:

```env
APP_ID=your_github_app_id
WEBHOOK_SECRET=your_webhook_secret
WEBHOOK_PROXY_URL=https://smee.io/your_smee_channel
PRIVATE_KEY_PATH=./private-key.pem
LOG_LEVEL=debug

# LLM Configuration
LLM_PROVIDER=gemini
LLM_API_KEY=your_gemini_api_key
LLM_MODEL=gemini-2.5-flash

# Phase 4: Database & pgvector
DATABASE_URL=postgres://postgres:postgres@localhost:5433/reviewbot

# Phase 5: Redis & Queue
REDIS_URL=redis://localhost:6380
```

> **Security Note:** `.env` and `*.pem` are strictly gitignored and never committed or baked into Docker images.

---

### Step 3: Start Infrastructure (PostgreSQL & Redis)

Start the required backends in Docker:

```bash
# Start PostgreSQL with pgvector (mapped to port 5433)
docker run -d --name pg -p 5433:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=reviewbot pgvector/pgvector:pg16

# Start Redis (mapped to port 6380)
docker run -d --name app-redis -p 6380:6379 redis:7-alpine
```

---

### Step 4: Run Database Migrations

Run the schema migrations to enable `pgvector` and initialize the multi-tenant tables (`installations`, `installation_settings`, `rules`, `reviews`, `comments`):

```bash
npm run migrate
```

Output:
```
[INFO] Connecting to database...
[INFO] Running migration: 001_initial_schema.sql
[SUCCESS] Applied migration 001_initial_schema.sql (took 32ms)
[SUCCESS] All schema migrations up to date!
```

---

### Step 5: Start the Bot

```bash
# Build TypeScript
npm run build

# Start local server with Smee webhook forwarder
npm run dev
```

Your bot is now live and listening on `http://localhost:3000`!

---

## Full Docker Compose Deployment

To launch the entire production stack (App, PostgreSQL with `pgvector`, and Redis) with a single command:

```bash
docker compose up -d
```

Check the health status of the entire stack:
```bash
curl http://localhost:3000/healthz
```

---

## Verification & Testing Suite

Vigilentia includes 126 automated unit and integration tests:

```bash
# Run all 126 unit & integration tests (Filters, Diff, LLM, RAG, Idempotency, Health, Auth)
npm test

# Run the ML retrieval evaluation benchmark (Hit Rate @ 3)
npm run eval:rag
```

---

## RAG Retrieval Benchmark (The ML Evaluation)

We evaluate retrieval quality across 10 diverse pull request scenarios in [`evals/cases.json`](evals/cases.json):

```
================================================================================
RAG RETRIEVAL EVALUATION RESULTS (Hit Rate @ 3)
================================================================================
ID | Result | Rank | Expected Rule                                          
---+--------+------+--------------------------------------------------------
 1 | HIT    | #1   | 1. Network Requests Must Have Timeouts and Error Handli
 2 | HIT    | #1   | 2. Safe Code Execution (Never Use eval)                
 3 | HIT    | #2   | 3. No Hardcoded Secrets or Credentials                 
 4 | HIT    | #1   | 4. Parameterized SQL Queries (No String Concatenation) 
 5 | HIT    | #1   | 5. Strict Input Validation on Public Functions and Endp
 6 | HIT    | #1   | 6. Use Structured Logging (No Raw console.log)         
 7 | HIT    | #3   | 7. Always Handle and Await Asynchronous Promises       
 8 | HIT    | #3   | 8. Resource Cleanup and Closing Connections            
 9 | HIT    | #1   | 9. Avoid Blocking the Node.js Event Loop               
10 | HIT    | #1   | 10. Descriptive Naming Conventions                     
================================================================================
[SUMMARY] Total Cases: 10
[SUMMARY] Total Hits:  10
[SUMMARY] Hit Rate @ 3: 100.0%

[SUCCESS] RAG Evaluation PASSED (Hit Rate >= 80%).
```

---

## Author & Contributing

Built step-by-step as an engineering deep-dive into AI infrastructure, vector databases, and asynchronous distributed systems.

- **Author:** [Nitin Kanojiya](https://github.com/Nitin-kanojiya26)
- **Repository:** [vigilentia](https://github.com/Nitin-kanojiya26/vigilentia.git)

---

## License

MIT License. Free to use, modify, and deploy for production code reviews.

