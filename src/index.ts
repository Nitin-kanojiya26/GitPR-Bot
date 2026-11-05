import { Probot } from "probot";
import { reviewQueue } from "./queue/reviewQueue.js";
import { createReviewWorker } from "./queue/worker.js";
import { buildBullJobId } from "./queue/idempotency.js";
import { handleHealthcheck } from "./health.js";
import { learnFromReviewComment } from "./review/learner.js";

interface AppOptions {
  addHandler?: (handler: (req: any, res: any) => Promise<boolean | void> | boolean | void) => void;
  [key: string]: unknown;
}

export default (app: Probot, options?: AppOptions) => {
  // 1. Register production healthcheck endpoint (/healthz and /health)
  if (options?.addHandler) {
    options.addHandler(async (req, res) => {
      return handleHealthcheck(req, res);
    });
  }

  // 2. Start the background review worker
  createReviewWorker(app);

  app.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"],
    async (context) => {
      const pr = context.payload.pull_request;

      // 1. Ignore drafts and bot accounts
      if (pr.draft || context.payload.sender.type === "Bot") {
        return;
      }

      const author = pr.user?.login ?? "unknown";
      context.log.info(
        `[INFO] PR #${pr.number} "${pr.title}" (${context.payload.action}) received from ${author}`
      );

      // 2. Fetch the live commit SHA
      const { data: livePR } = await context.octokit.rest.pulls.get({
        ...context.pullRequest(),
      });

      const installationId = context.payload.installation?.id;
      const jobData = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        pullNumber: pr.number,
        headSha: livePR.head.sha,
        installationId,
      };

      const jobId = buildBullJobId(jobData);

      // 3. Enqueue the review job with unique jobId to prevent duplicate queue items
      await reviewQueue.add("review-pr", jobData, { jobId });

      context.log.info(
        `[SUCCESS] Enqueued review job for PR #${pr.number} at commit ${livePR.head.sha.slice(0, 7)}. Responding HTTP 200 immediately.`
      );
    }
  );

  // 3. Shadowing Engine: Learn team patterns from human review comments
  app.on("pull_request_review_comment.created", async (context) => {
    const comment = context.payload.comment;

    // Ignore bot accounts to prevent feedback loops
    if (context.payload.sender.type === "Bot" || comment.user?.type === "Bot") {
      return;
    }

    const repoFullName = context.payload.repository.full_name;
    const author = comment.user?.login ?? "human";
    context.log.info(
      `[INFO] Review comment received from ${author} on ${repoFullName}#${context.payload.pull_request.number}`
    );

    await learnFromReviewComment(
      repoFullName,
      comment.body,
      comment.diff_hunk,
      context.log
    );
  });
};
