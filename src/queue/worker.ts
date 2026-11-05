import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { Probot } from "probot";
import { ReviewJobData, QUEUE_NAME } from "./reviewQueue.js";
import { reviewPullRequest } from "../review/reviewPR.js";
import { acquireReviewLock } from "./idempotency.js";
import {
  isCommitAlreadyReviewed,
  checkInstallationHourlyCap,
} from "./delivery.js";
import { recordReviewResult } from "../review/persistence.js";
import {
  getDecryptedInstallationKey,
  hasPostedNoKeyWarning,
  recordNoKeyWarning,
} from "../settings/service.js";

/**
 * Creates and starts a BullMQ Worker to process asynchronous PR review jobs.
 */
export function createReviewWorker(app: Probot): Worker<ReviewJobData> {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";

  const workerConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  workerConnection.on("error", (err: any) => {
    if (process.env.NODE_ENV !== "test") {
      app.log.warn(`[WARN] [QueueWorker] Redis connection error: ${err?.message || err}`);
    }
  });

  const worker = new Worker<ReviewJobData>(
    QUEUE_NAME,
    async (job: Job<ReviewJobData>) => {
      const { owner, repo, pullNumber, headSha, installationId } = job.data;

      // Idempotency check: Ensure duplicate deliveries for the same commit are discarded
      const hasLock = await acquireReviewLock(workerConnection, {
        owner,
        repo,
        pullNumber,
        headSha,
      });

      if (!hasLock) {
        app.log.warn(
          `[WARN] Skipping duplicate review for ${owner}/${repo}#${pullNumber} (${headSha.slice(0, 7)}) - already processed or in progress.`
        );
        return;
      }

      // 1. Commit SHA Idempotency: Avoid reviewing the same head_sha twice
      const alreadyReviewed = await isCommitAlreadyReviewed(`${owner}/${repo}`, pullNumber, headSha);
      if (alreadyReviewed) {
        app.log.warn(
          `[WARN] Commit ${headSha.slice(0, 7)} on ${owner}/${repo}#${pullNumber} was already reviewed. Skipping duplicate.`
        );
        return;
      }

      // 2. Per-installation hourly review cap (max 20 reviews/hour)
      if (installationId) {
        const { allowed, currentCount } = await checkInstallationHourlyCap(installationId);
        if (!allowed) {
          app.log.warn(
            `[WARN] Installation #${installationId} exceeded hourly limit (${currentCount} reviews in last hour). Skipping review.`
          );
          await recordReviewResult({
            installationId,
            repo: `${owner}/${repo}`,
            prNumber: pullNumber,
            headSha,
            status: "rate_limited",
            commentsPosted: 0,
            error: `Hourly review limit exceeded (${currentCount}/20 reviews in last hour).`,
          });
          return;
        }
      }

      app.log.info(
        `[INFO] Processing queued review job for ${owner}/${repo}#${pullNumber} (${headSha.slice(0, 7)})`
      );

      // Authenticate an Octokit client for this installation
      let octokit;
      if (installationId) {
        octokit = await app.auth(installationId);
      } else {
        octokit = await app.auth();
      }

      // 1. Fetch decrypted Gemini API key for this installation
      let apiKey: string | null = null;
      if (installationId) {
        apiKey = await getDecryptedInstallationKey(installationId);
      }

      // 2. Fallback: If no tenant key is configured and no server key is present
      if (!apiKey && !process.env.LLM_API_KEY) {
        const repoFullName = `${owner}/${repo}`;
        const alreadyWarned = await hasPostedNoKeyWarning(repoFullName);

        if (!alreadyWarned) {
          app.log.warn(
            `[WARN] No Gemini API key found for installation #${installationId} on ${repoFullName}. Posting setup notice.`
          );

          const setupUrl = `${process.env.BASE_URL || ""}/setup`;
          try {
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: pullNumber,
              body: `🤖 **Vigilentia Setup Required**\n\nTo enable automated AI code reviews for pull requests, please configure your free Google Gemini API key at:\n👉 [**Configure Vigilentia Settings**](${setupUrl})\n\n*Vigilentia stores your key encrypted with AES-256-GCM and decrypts it only in-memory during review processing.*`,
            });
            await recordNoKeyWarning(installationId || 0, repoFullName, pullNumber);
          } catch (err: any) {
            app.log.error(
              `[ERROR] Failed to post no-key setup comment on ${repoFullName}#${pullNumber}:`,
              err?.message || err
            );
          }
        } else {
          app.log.info(
            `[INFO] Skipping review for ${repoFullName}#${pullNumber}: No Gemini key configured (setup notice already posted).`
          );
        }
        return;
      }

      await reviewPullRequest(
        octokit,
        {
          owner,
          repo,
          pullNumber,
          headSha,
          installationId,
        },
        app.log,
        apiKey || undefined
      );
    },
    {
      connection: workerConnection,
      concurrency: 2, // Process up to 2 reviews simultaneously
    }
  );

  worker.on("completed", (job) => {
    app.log.info(`[SUCCESS] Job ${job.id} for PR #${job.data.pullNumber} completed.`);
  });

  worker.on("failed", (job, err) => {
    app.log.error(`[ERROR] Job ${job?.id} failed with error: ${err.message}`);
  });

  return worker;
}
