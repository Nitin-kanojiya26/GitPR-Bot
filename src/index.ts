import { Probot } from "probot";

export default (app: Probot) => {
  app.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"],
    async (context) => {
      const pr = context.payload.pull_request;

      if (pr.draft || context.payload.sender.type === "Bot") {
        return;
      }

      const author = pr.user?.login ?? "unknown";
      context.log.info(
        `PR #${pr.number} "${pr.title}" (${context.payload.action}) received from ${author}`
      );

      // Fetch the files changed in this Pull Request
      const { data: files } = await context.octokit.rest.pulls.listFiles({
        ...context.pullRequest(),
        per_page: 100,
      });

      context.log.info(`Found ${files.length} changed file(s):`);

      for (const file of files) {
        context.log.info(`  • ${file.filename} (status: ${file.status}, +${file.additions}/-${file.deletions})`);
        if (file.patch) {
          context.log.info(`--- Diff for ${file.filename} ---\n${file.patch}\n-----------------------`);
        } else {
          context.log.info(`  (No patch available for ${file.filename} — binary or unchanged)`);
        }
      }
    }
  );
};
