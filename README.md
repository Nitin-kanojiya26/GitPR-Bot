# GitPR-Bot: Autonomous AI Pull Request Reviewer

An enterprise-grade, production-hardened GitHub App that automatically reviews pull requests with line-level accuracy, grounded in your team's engineering standards using **Retrieval-Augmented Generation (RAG)**, **PostgreSQL (`pgvector`)**, and **Google Gemini 2.5**.

---

## The Problem

Code reviews are one of the biggest bottlenecks in modern engineering teams:
- **Review Fatigue:** Senior engineers spend hours reviewing boilerplate, missing subtle security flaws (like raw `eval()`, unhandled promises, or missing network timeouts).
- **Style Guide Decay:** Teams write comprehensive 20-page engineering guidelines that get forgotten because nobody memorizes every rule.
- **Generic AI Bots Fail:** Typical AI review bots hallucinate invalid line numbers (triggering GitHub HTTP 422 errors), lack knowledge of company-specific guidelines, or timeout on GitHub's strict 10-second webhook limit.

**GitPR-Bot** is engineered from the ground up to solve these problems without heavy, black-box AI frameworks. Every line of parsing, embedding, retrieval, queuing, and posting is modular, transparent, and strictly validated.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph GitHub ["GitHub Infrastructure"]
        PR["Developer Opens / Updates PR"] --> WH["GitHub Webhook Delivery"]
        GH_API["GitHub REST API (octokit)"]
    end

    subgraph Ingestion ["Ingestion Layer (src/index.ts)"]
        WH -->|Signed Webhook| PROBOT["Probot Handler"]
        PROBOT -->|1. Instant HTTP 200 OK (<15ms)| WH
        PROBOT -->|2. Enqueue Review Job| QUEUE["BullMQ (pr-reviews)"]
    end

    subgraph QueueLayer ["Async Queue & Idempotency (src/queue/)"]
        QUEUE --> REDIS[("Redis Cache & Queue (Port 6380)")]
        REDIS -->|SET ... NX EX| LOCK["Idempotency Lock (Deduplication)"]
        REDIS --> WORKER["BullMQ Worker (concurrency: 2)"]
    end

    subgraph ReviewPipeline ["Review & RAG Pipeline (src/review/)"]
        WORKER --> FETCH["Fetch Changed Files (octokit)"]
        FETCH --> FILTER["File Filtering (skip lockfiles, binaries, dist)"]
        FILTER --> NUMBER["Numbered Diff (L<n>: +) & Legal Line Set"]
        
        NUMBER --> RAG_EMBED["Embed Diff Summary (gemini-embedding-001)"]
        RAG_EMBED --> PG[("PostgreSQL 16 + pgvector (Port 5433)")]
        PG -->|<=> Cosine Distance| TOP_RULES["Retrieve Top 3 Style Rules"]
        
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
| **Unit Testing** | Vitest | Fast TypeScript unit testing (25 passing tests) |
| **Containerization** | Docker & Docker Compose | Multi-stage image build and service orchestration |

---

## Directory Structure

```
GitPRBot/
├── db/
│   ├── schema.sql            # PostgreSQL schema with pgvector extension & 768-D table
│   └── seed.ts               # One-time idempotent style guide vector seeding script
├── docs/
│   └── style-guide.md        # 10 production engineering rules enforced by the bot
├── evals/
│   ├── cases.json            # 10 labeled test diffs for benchmarking retrieval
│   └── eval-rag.js           # RAG evaluation script measuring Hit Rate @ 3
├── scripts/
│   ├── test-health.js        # Deep healthcheck diagnostic probe
│   ├── test-idempotency.js   # Live Redis atomic lock verification
│   ├── test-llm.js           # Live Gemini connectivity probe
│   ├── test-queue.js         # BullMQ queue & worker test
│   ├── test-rag-review.js    # End-to-end RAG + Gemini review test
│   └── test-rag.js           # Live vector similarity search verification
├── src/
│   ├── index.ts              # Probot entrypoint & webhook router
│   ├── health.ts             # Healthcheck service & HTTP handler (/healthz)
│   ├── queue/
│   │   ├── idempotency.ts    # Redis distributed lock implementation
│   │   ├── reviewQueue.ts    # BullMQ queue configuration
│   │   └── worker.ts         # BullMQ background review worker
│   └── review/
│       ├── diff.ts           # Numbered diffs & legal line number calculations
│       ├── filters.ts        # File filtering rules (lockfiles, minified, binaries)
│       ├── github.ts         # Octokit review comment posting wrapper
│       ├── llm.ts            # Swappable Gemini client, Zod schemas, auto-retry
│       ├── rag.ts            # pgvector semantic rule retriever
│       └── reviewPR.ts       # Main review orchestrator
├── test/                     # Vitest unit test suites
│   ├── diff.test.ts
│   ├── filters.test.ts
│   ├── health.test.ts
│   ├── idempotency.test.ts
│   ├── llm.test.ts
│   └── rag.test.ts
├── .dockerignore             # Protects credentials and secrets from Docker builds
├── docker-compose.yml        # Orchestration for bot, postgres-pgvector, and redis
├── Dockerfile                # Multi-stage production container build
├── package.json              # NPM dependencies and scripts
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
git clone https://github.com/Nitin-kanojiya26/GitPR-Bot.git
cd GitPR-Bot
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

### Step 4: Seed the Style Guide into pgvector

Run the idempotent database seed script to chunk [`docs/style-guide.md`](docs/style-guide.md), compute 768-D embeddings, and insert them into PostgreSQL:

```bash
npm run seed
```

Output:
```
[INFO] Starting style guide database seed...
[INFO] Schema initialized with vector extension.
[INFO] Found 10 rules in docs/style-guide.md
[INFO] Embedding rule [1/10]: "1. Network Requests Must Have Timeouts and Error Handling"...
...
[SUCCESS] Successfully embedded and stored 10 rules into pgvector!
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

GitPR-Bot includes a complete testing and diagnostic suite:

```bash
# 1. Run all 25 unit tests (Filters, Diff, LLM, RAG, Idempotency, Health)
npm test

# 2. Probe live /healthz endpoint (Postgres & Redis latency check)
npm run test:health

# 3. Test Redis queue job producer & consumer
npm run test:queue

# 4. Verify atomic lock idempotency (blocks duplicate events)
npm run test:idempotency

# 5. Test live semantic vector search from PostgreSQL
npm run test:rag

# 6. Test live RAG + Gemini review generation with rule citations
npm run test:rag-review

# 7. Run the ML retrieval evaluation benchmark (Hit Rate @ 3)
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
- **Repository:** [GitPR-Bot](https://github.com/Nitin-kanojiya26/GitPR-Bot.git)

---

## License

MIT License. Free to use, modify, and deploy for production code reviews.

