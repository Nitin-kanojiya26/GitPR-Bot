import { Probot } from "probot";
import { getCommentableLines } from "./review/diff.js";
import { shouldReviewFile } from "./review/filters.js";
import { InlineComment } from "./review/github.js";

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

      // 1. Fetch the LIVE Pull Request data for real commit SHA
      const { data: livePR } = await context.octokit.rest.pulls.get({
        ...context.pullRequest(),
      });

      // 2. Fetch changed files
      const { data: files } = await context.octokit.rest.pulls.listFiles({
        ...context.pullRequest(),
        per_page: 100,
      });

      context.log.info(`Found ${files.length} changed file(s).`);

      const reviewComments: InlineComment[] = [];

      for (const file of files) {
        // 3. Apply filters: skip lockfiles, compiled outputs, images, and huge diffs
        const filterResult = shouldReviewFile(file);
        if (!filterResult.review) {
          context.log.info(`Skipping "${file.filename}": ${filterResult.reason}`);
          continue;
        }

        // 4. Safe commentable lines check
        const commentableLines = getCommentableLines(file.patch!);
        context.log.info(
          `File "${file.filename}" has commentable lines: [${Array.from(commentableLines).join(", ")}]`
        );

        if (commentableLines.size > 0) {
          const validLine = Array.from(commentableLines)[0];
          reviewComments.push({
            path: file.filename,
            line: validLine,
            body: `🤖 **Test Review Bot:** Valid comment on line ${validLine} of \`${file.filename}\` (safely verified by \`getCommentableLines\`).`,
          });
        }
      }

      // 5. Post review using the LIVE commit SHA
      if (reviewComments.length > 0) {
        await context.octokit.rest.pulls.createReview({
          ...context.pullRequest(),
          commit_id: livePR.head.sha,
          event: "COMMENT",
          body: "🤖 **Automated PR Review Test**\nAll inline comments are safely aligned to valid diff lines.",
          comments: reviewComments.map((c) => ({
            path: c.path,
            line: c.line,
            side: "RIGHT" as const,
            body: c.body,
          })),
        });

        context.log.info(`🎉 Successfully posted review to GitHub PR #${pr.number}!`);
      }
    }
  );
};
