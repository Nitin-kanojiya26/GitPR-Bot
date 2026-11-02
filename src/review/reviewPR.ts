import { Context } from "probot";
import { getCommentableLines, numberedDiff } from "./diff.js";
import { shouldReviewFile } from "./filters.js";
import { generateReview, ReviewComment } from "./llm.js";

export type OctokitInstance = Context["octokit"];

export interface ReviewParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, ...args: unknown[]) => void;
  debug?: (msg: string) => void;
}

const SEVERITY_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Normalizes file paths so "calc.js", "./calc.js", and "/calc.js" match reliably.
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/^\.?\//, "").trim();
}

export async function reviewPullRequest(
  octokit: OctokitInstance,
  params: ReviewParams,
  log: Logger = console
) {
  const { owner, repo, pullNumber, headSha } = params;

  log.info(`Starting review for ${owner}/${repo}#${pullNumber} at commit ${headSha.slice(0, 7)}`);

  try {
    // 1. Fetch changed files from GitHub
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    log.info(`Fetched ${files.length} file(s) from PR #${pullNumber}`);

    // 2. Filter files and build diffs
    const diffsToReview: { filename: string; diff: string }[] = [];
    const commentableLinesMap = new Map<string, Set<number>>();

    for (const file of files) {
      const filterResult = shouldReviewFile(file);
      if (!filterResult.review) {
        log.info(`Skipping file "${file.filename}": ${filterResult.reason}`);
        continue;
      }

      const normalizedFilename = normalizePath(file.filename);
      const commentableLines = getCommentableLines(file.patch!);
      commentableLinesMap.set(normalizedFilename, commentableLines);

      const formattedDiff = numberedDiff(file.patch!);
      log.info(`Diff for "${normalizedFilename}":\n${formattedDiff}`);
      log.info(`Legal line numbers for "${normalizedFilename}": [${Array.from(commentableLines).join(", ")}]`);

      diffsToReview.push({ filename: normalizedFilename, diff: formattedDiff });
    }

    if (diffsToReview.length === 0) {
      log.info(`No reviewable code files found in PR #${pullNumber}.`);
      return;
    }

    // 3. Ask Gemini to review the code
    log.info(`Sending ${diffsToReview.length} file(s) to Gemini for review...`);
    const rawAiComments = await generateReview(diffsToReview);
    log.info(`Gemini returned ${rawAiComments.length} suggestion(s).`);

    // 4. Hallucination Defense: Drop comments on lines outside the diff
    const validComments: ReviewComment[] = [];

    for (const comment of rawAiComments) {
      const normalizedCommentFile = normalizePath(comment.file);
      const legalLines = commentableLinesMap.get(normalizedCommentFile);

      if (!legalLines || !legalLines.has(comment.line)) {
        log.warn(
          `⚠️ Dropping hallucinated comment on ${comment.file}:${comment.line} (Line not in diff or file mismatch)`
        );
        continue;
      }
      validComments.push({
        ...comment,
        file: normalizedCommentFile,
      });
    }

    // 5. Sort by severity (high first) and cap at 10 comments
    validComments.sort(
      (a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0)
    );
    const finalComments = validComments.slice(0, 10);

    // 6. Post review to GitHub
    if (finalComments.length === 0) {
      log.info(`No bugs or code issues found. Posting approval comment.`);
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: headSha,
        event: "COMMENT",
        body: "🤖 **AI Pull Request Review**\n\n✅ Checked changed files. No bugs, security issues, or major style violations found. Clean work!",
      });
      return;
    }

    // Map comments to GitHub's Review API structure
    const githubComments = finalComments.map((c) => ({
      path: c.file,
      line: c.line,
      side: "RIGHT" as const,
      body: `**[${c.severity.toUpperCase()}]** ${c.comment}`,
    }));

    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: `🤖 **AI Pull Request Review**\nFound ${finalComments.length} recommendation(s) in this pull request:`,
      comments: githubComments,
    });

    log.info(`🎉 Successfully posted AI review with ${finalComments.length} comment(s)!`);
  } catch (error) {
    log.error(`❌ Review failed for PR #${pullNumber}:`, error);
  }
}
