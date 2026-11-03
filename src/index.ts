import { Probot } from "probot";
import { reviewQueue } from "./queue/reviewQueue.js";
import { createReviewWorker } from "./queue/worker.js";

export default (app: Probot) => {
  // Start the background review worker
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

      // 3. Enqueue the review job for asynchronous background processing
      await reviewQueue.add("review-pr", {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        pullNumber: pr.number,
        headSha: livePR.head.sha,
        installationId,
      });

      context.log.info(
        `[SUCCESS] Enqueued review job for PR #${pr.number} at commit ${livePR.head.sha.slice(0, 7)}. Responding HTTP 200 immediately.`
      );
    }
  );
};
