import { Context } from "probot";

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Posts a unified code review with inline comments on the Pull Request.
 */
export async function postReview(
  context: Context<"pull_request.opened" | "pull_request.synchronize" | "pull_request.reopened">,
  comments: InlineComment[],
  summary = "AI Pull Request Review"
) {
  const pr = context.payload.pull_request;

  if (comments.length === 0) {
    context.log.info(`No comments to post for PR #${pr.number}.`);
    return;
  }

  // Map to GitHub's Review API comment structure
  const formattedComments = comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    body: c.body,
  }));

  await context.octokit.rest.pulls.createReview({
    ...context.pullRequest(),
    commit_id: pr.head.sha,
    event: "COMMENT",
    body: summary,
    comments: formattedComments,
  });

  context.log.info(
    `Successfully posted review with ${comments.length} comment(s) on PR #${pr.number}!`
  );
}

