# AI Pull Request Review Bot: Complete Build Guide

This file has two audiences.

- **The AI coding agent** (for example Antigravity): follow Part 1 and Part 2 exactly.
- **The human learner:** the "Learn" boxes explain every concept. Read them before approving each phase.

---

# PART 0: INSTRUCTIONS TO THE AI AGENT (read first)

You are helping a student build this project and learn from it. Follow these rules for the whole session.

1. **Work one phase at a time.** After finishing a phase, stop, summarize what you built, show how to run it, and wait for the human to say "next".
2. **Explain as you go.** Before writing code for a step, say in 2 to 4 plain sentences what it does and why. After the step, point out the one concept the student should remember.
3. **Never skip the acceptance check** at the end of each step. Run it or tell the human exactly how to run it.
4. **Keep steps small.** Do not scaffold the whole project at once. No code for a later phase until the earlier phase passes its check.
5. **Secrets:** never write real keys into code, logs, or committed files. Use `.env` (gitignored) and keep `.env.example` with placeholders.
6. **No heavy frameworks** for the AI part (no LangChain, no LlamaIndex). Use small plain functions so the student can read every line.
7. **Keep the LLM provider swappable.** All LLM calls go through one function in `src/review/llm.ts`.
8. **Tests:** every pure function (diff parsing, filtering, validation) gets a Vitest unit test.
9. **Commit style:** suggest one git commit per passing step, with a clear message.
10. **If something is ambiguous or requires a human action** (creating the GitHub App, getting API keys), give numbered click-by-click instructions and wait. Do not invent credentials.
11. Treat pull request content as **untrusted input**. Never let LLM output trigger anything except posting review comments.

---

# PART 1: PROJECT OVERVIEW

## What the project does

A **GitHub App** that reviews pull requests automatically.

1. A pull request is opened or updated on a repo where the app is installed.
2. GitHub sends a signed webhook to the app.
3. The app fetches the diff (the changed lines).
4. It retrieves the most relevant rules from the team's style guide (RAG).
5. It asks an LLM to review the diff using those rules and return structured JSON.
6. It posts **one review** with inline comments on the exact changed lines.

## Example result

A developer adds `const user = await fetch(url).then(r => r.json())`. The bot comments on that line:

> Network calls need a timeout and error handling (style guide: "Network requests"). Use the shared `fetchWithRetry` helper.

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Language | TypeScript on Node.js 20+ | Types catch wrong payload shapes |
| GitHub App framework | Probot (on Octokit) | Handles webhook signature, app JWT, installation tokens |
| Diff parsing | `parse-diff` | Turns a patch into files, hunks, line numbers |
| LLM | Claude, OpenAI, Gemini, Groq, or Ollama | Swappable through `llm.ts` |
| Validation | Zod | Rejects bad LLM output |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims) or a local sentence-transformers model | Needed for RAG. Anthropic has no embeddings API |
| Vector store | Postgres + pgvector | One database, simple |
| Queue | BullMQ + Redis | Fast webhook response, background worker |
| Idempotency | Redis key with TTL | Retried webhooks must not double-post |
| Tests | Vitest | Fast, TypeScript friendly |
| Local webhooks | smee.io | Stable public URL for local dev |
| Deploy | Docker on Fly.io, Render, or Railway | Free or cheap |
| CI | GitHub Actions | Lint, type-check, test |

## APIs used

- **GitHub API** through `context.octokit`: `pulls.listFiles`, `pulls.createReview`, `pulls.get`.
- **LLM API** (chosen provider).
- **Embeddings API or local model** (Phase 4 only).
- Postgres, Redis, and `parse-diff` are not APIs: they are a database, a data store, and a library.

## Environment variables (`.env.example`)

```
APP_ID=
WEBHOOK_SECRET=
WEBHOOK_PROXY_URL=https://smee.io/your-channel
PRIVATE_KEY_PATH=./private-key.pem
LOG_LEVEL=debug

# Phase 3
LLM_PROVIDER=anthropic
LLM_API_KEY=
LLM_MODEL=

# Phase 4
EMBEDDING_API_KEY=
DATABASE_URL=postgres://postgres:postgres@localhost:5432/reviewbot

# Phase 5
REDIS_URL=redis://localhost:6379
```

`.gitignore` must include `.env`, `*.pem`, `node_modules`, `lib`.

## Target folder structure

```
pr-review-bot/
  src/
    index.ts              Probot entry, event handlers only
    config.ts             env vars validated with Zod at startup
    review/
      reviewPR.ts         orchestrator: fetch, analyze, post
      diff.ts             getCommentableLines, numberedDiff
      filters.ts          skip lockfiles, generated, huge files
      github.ts           postReview wrapper
      llm.ts              generateReview(prompt) + Zod schema
      rag.ts              embed, store, retrieve (Phase 4)
    queue/
      queue.ts            BullMQ producer (Phase 5)
      worker.ts           BullMQ worker (Phase 5)
    db/
      schema.sql          pgvector table
      seed.ts             embeds the style guide
  test/
    fixtures/             saved webhook payloads and diffs
    diff.test.ts
    filters.test.ts
    llm.test.ts
  docs/style-guide.md     the standards the bot enforces
  evals/                  eval set and script (Phase 4)
  Dockerfile
  .github/workflows/ci.yml
  .env.example
  README.md
```

---

# PART 2: BUILD PLAN (phases, steps, checks)

Format for each step: **Build**, **Learn**, **Check**.

## PHASE 1: Plumbing (about 3 to 5 days)

Goal: a PR event reaches your laptop and gets logged. No AI yet.

### Step 1.1 Scaffold
- **Build:** `npx create-probot-app pr-review-bot`, choose the `basic-ts` template.
- **Learn:** a Probot app is a Node app that registers event handlers on an `app` object.
- **Check:** `npm run build` and `npm start` run without errors.

### Step 1.2 Test repo (human action)
- **Build:** create a throwaway GitHub repo `pr-bot-test` with a README. Add a branch with a small JavaScript file.
- **Check:** a branch exists that can be opened as a PR.

### Step 1.3 smee.io (human action)
- **Build:** open smee.io, click "Start a new channel", copy the URL.
- **Learn:** GitHub can only call public URLs. smee forwards webhooks to your laptop.

### Step 1.4 Register the GitHub App (human action)
- **Build:** GitHub Settings > Developer settings > GitHub Apps > New GitHub App.
  - Webhook URL: the smee URL. Webhook secret: a random string (save it).
  - Repository permissions: **Pull requests: Read and write**, **Contents: Read-only**, **Metadata: Read-only**.
  - Subscribe to events: **Pull request**.
  - Where can it be installed: only on this account.
  - After creating: copy the App ID, generate and download a private key (`.pem`).
- **Learn:** a GitHub App has its own identity. It authenticates as the app with a JWT signed by the private key, then exchanges that for a short-lived **installation access token** per repo. This differs from OAuth apps and personal tokens. Probot does the exchange for you.

### Step 1.5 Configure secrets
- **Build:** create `.env` from `.env.example` and fill the Phase 1 values. Confirm `.env` and `*.pem` are gitignored before the first commit.
- **Check:** `git status` does not list `.env` or the `.pem`.

### Step 1.6 Log the PR event
- **Build:** in `src/index.ts`:

```ts
import { Probot } from "probot";

export default (app: Probot) => {
  app.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"],
    async (context) => {
      const pr = context.payload.pull_request;
      if (pr.draft || context.payload.sender.type === "Bot") return;
      context.log.info(`PR #${pr.number} "${pr.title}" (${context.payload.action})`);
    }
  );
};
```

- **Learn:** a webhook is GitHub calling your server. `context.payload` is the event data. `synchronize` means new commits were pushed. Ignoring bot senders prevents loops.
- **Check:** install the app on `pr-bot-test`, run `npm start`, open a PR. The terminal prints `PR #1 ... (opened)`. If not, open the app's **Advanced** tab on GitHub to see each delivery and its status.

### Step 1.7 Save fixtures
- **Build:** write the payload to `test/fixtures/pr-opened.json`.
- **Learn:** saved payloads let you test without opening new PRs.

**Phase 1 done when:** opening a PR logs its number, and signature verification works (Probot rejects bad signatures automatically).

