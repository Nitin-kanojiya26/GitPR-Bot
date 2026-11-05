import { Probot } from "probot";
import { reviewQueue } from "./queue/reviewQueue.js";
import { createReviewWorker } from "./queue/worker.js";
import { buildBullJobId } from "./queue/idempotency.js";
import { learnFromReviewComment } from "./review/learner.js";
import { createWebApp } from "./web/app.js";
import {
  handleInstallationCreated,
  handleInstallationDeleted,
} from "./installations/service.js";
import {
  markThreadResolved,
  markThreadUnresolved,
  markUnresolvedCommentsIgnored,
} from "./review/outcomes.js";

interface AppOptions {
  addHandler?: (handler: (req: any, res: any) => Promise<boolean | void> | boolean | void) => void;
  [key: string]: unknown;
}

export default (app: Probot, options?: AppOptions) => {
  // 1. Mount unified Express web application (Landing, Dashboard, Settings, Health)
  if (options?.addHandler) {
    const webApp = createWebApp(app);
    options.addHandler(webApp);
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

  // 4. Installation Lifecycle Events: Onboard and purge tenants
  app.on("installation.created", async (context) => {
    const inst = context.payload.installation;
    const account = inst.account as any;
    const accountLogin = account?.login || account?.name || account?.slug || "unknown";
    const accountType = account?.type || "User";

    context.log.info(
      `[INFO] Installation created: #${inst.id} for ${accountLogin} (${accountType})`
    );
    await handleInstallationCreated(inst.id, accountLogin, accountType);
  });

  app.on("installation.deleted", async (context) => {
    const inst = context.payload.installation;
    const account = inst.account as any;
    const accountLogin = account?.login || account?.name || account?.slug || "unknown";

    context.log.info(
      `[INFO] Installation deleted: #${inst.id} for ${accountLogin}. Purging all tenant data.`
    );
    await handleInstallationDeleted(inst.id);
  });

  app.on(
    ["installation_repositories.added", "installation_repositories.removed"],
    async (context) => {
      const inst = context.payload.installation;
      context.log.info(
        `[INFO] Installation repositories updated for #${inst.id} (${context.payload.action})`
      );
    }
  );

  // 5. Outcome Tracking: Listen for PR close and review thread resolution events
  app.on("pull_request.closed", async (context) => {
    const pr = context.payload.pull_request;
    const repoFullName = context.payload.repository.full_name;
    const isMerged = Boolean(pr.merged);

    context.log.info(
      `[INFO] PR #${pr.number} on ${repoFullName} closed (merged: ${isMerged}). Marking unresolved comments as 'ignored'.`
    );

    const updated = await markUnresolvedCommentsIgnored(repoFullName, pr.number);
    context.log.info(
      `[SUCCESS] Marked ${updated} unresolved comment(s) as 'ignored' on ${repoFullName}#${pr.number}`
    );
  });

  app.on("pull_request_review_thread.resolved" as any, async (context: any) => {
    const thread = context.payload.thread;
    const repoFullName = context.payload.repository.full_name;
    const commentIds = (thread?.comments || []).map((c: any) => c.id);

    context.log.info(
      `[INFO] Review thread resolved on ${repoFullName} (comment IDs: [${commentIds.join(", ")}]). Updating outcome to 'fixed'.`
    );

    const updated = await markThreadResolved(commentIds);
    context.log.info(`[SUCCESS] Marked ${updated} comment(s) as 'fixed' on ${repoFullName}`);
  });

  app.on("pull_request_review_thread.unresolved" as any, async (context: any) => {
    const thread = context.payload.thread;
    const repoFullName = context.payload.repository.full_name;
    const commentIds = (thread?.comments || []).map((c: any) => c.id);

    context.log.info(
      `[INFO] Review thread unresolved on ${repoFullName} (comment IDs: [${commentIds.join(", ")}]). Reverting outcome to 'open'.`
    );

    const updated = await markThreadUnresolved(commentIds);
    context.log.info(`[SUCCESS] Reverted ${updated} comment(s) back to 'open' on ${repoFullName}`);
  });
};
