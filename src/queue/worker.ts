import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { Probot } from "probot";
import { ReviewJobData, QUEUE_NAME } from "./reviewQueue.js";
import { reviewPullRequest } from "../review/reviewPR.js";
import { acquireReviewLock } from "./idempotency.js";

/**
 * Creates and starts a BullMQ Worker to process asynchronous PR review jobs.
 */
export function createReviewWorker(app: Probot): Worker<ReviewJobData> {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";

  const workerConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
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

      await reviewPullRequest(
        octokit,
        {
          owner,
          repo,
          pullNumber,
          headSha,
        },
        app.log
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
