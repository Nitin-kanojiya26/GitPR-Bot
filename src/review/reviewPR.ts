import { Context } from "probot";
import { getCommentableLines, numberedDiff } from "./diff.js";
import { shouldReviewFile, filterDuplicateComments } from "./filters.js";
import { generateReview, ReviewComment } from "./llm.js";
import { retrieveRules, formatRulesForPrompt } from "./rag.js";

export type OctokitInstance = Context["octokit"];

export interface ReviewParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  installationId?: number;
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, ...args: unknown[]) => void;
  debug?: (msg: string) => void;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
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
  log: Logger = console,
  customApiKey?: string
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

    // 3. Retrieve relevant team style rules via pgvector RAG
    const diffSummary = diffsToReview
      .map((d) => `${d.filename}\n${d.diff}`)
      .join("\n")
      .slice(0, 2000);

    log.info(`Retrieving relevant style rules from pgvector for ${owner}/${repo}...`);
    const retrievedRules = await retrieveRules(diffSummary, 3, `${owner}/${repo}`);
    if (retrievedRules.length > 0) {
      log.info(`Retrieved ${retrievedRules.length} style rule(s): ${retrievedRules.map((r) => r.title).join(", ")}`);
    }
    const rulesPrompt = formatRulesForPrompt(retrievedRules);

    // 4. Ask Gemini to review the code with style guide awareness
    log.info(`Sending ${diffsToReview.length} file(s) to Gemini for review...`);
    const rawAiComments = await generateReview(diffsToReview, rulesPrompt, customApiKey);
    log.info(`Gemini returned ${rawAiComments.length} suggestion(s).`);

    // 5. Hallucination Defense: Drop comments on lines outside the diff
    const validComments: ReviewComment[] = [];

    for (const comment of rawAiComments) {
      const normalizedCommentFile = normalizePath(comment.file);
      const legalLines = commentableLinesMap.get(normalizedCommentFile);

      if (!legalLines || !legalLines.has(comment.line)) {
        log.warn(
          `[WARN] Dropping hallucinated comment on ${comment.file}:${comment.line} (Line not in diff or file mismatch)`
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

    // 6. Deduplication Defense: Fetch existing comments to prevent posting duplicates across commits
    let existingComments: any[] = [];
    try {
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      existingComments = data;
    } catch (err: any) {
      log.warn(`[WARN] Could not fetch existing PR comments for deduplication: ${err?.message || err}`);
    }

    const newComments = filterDuplicateComments(finalComments, existingComments);

    if (newComments.length === 0) {
      if (finalComments.length > 0) {
        log.info(
          `[INFO] All ${finalComments.length} detected issue(s) were already commented on in previous commits. Skipping redundant review post.`
        );
        return;
      }

      // Check if PR was already reviewed previously
      try {
        const { data: existingReviews } = await octokit.rest.pulls.listReviews({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 10,
        });
        if (existingReviews.length > 0) {
          log.info(`[INFO] PR #${pullNumber} was already reviewed previously. Skipping duplicate approval comment.`);
          return;
        }
      } catch {
        // Continue to post initial approval if listReviews fails
      }

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
    const githubComments = newComments.map((c) => ({
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
      body: `🤖 **AI Pull Request Review**\nFound ${newComments.length} recommendation(s) in this pull request:`,
      comments: githubComments,
    });

    log.info(`[SUCCESS] Successfully posted AI review with ${newComments.length} comment(s)!`);
  } catch (error) {
    log.error(`[ERROR] Review failed for PR #${pullNumber}:`, error);
  }
}
