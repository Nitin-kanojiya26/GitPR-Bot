import { Probot } from "probot";
import { reviewPullRequest } from "./review/reviewPR.js";

export default (app: Probot) => {
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
        `PR #${pr.number} "${pr.title}" (${context.payload.action}) received from ${author}`
      );

      // 2. Fetch the live commit SHA
      const { data: livePR } = await context.octokit.rest.pulls.get({
        ...context.pullRequest(),
      });

      // 3. Run the AI reviewer
      await reviewPullRequest(
        context.octokit,
        {
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          pullNumber: pr.number,
          headSha: livePR.head.sha,
        },
        context.log
      );
    }
  );
};
