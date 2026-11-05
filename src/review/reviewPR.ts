import { Context } from "probot";
import { getCommentableLines, numberedDiff } from "./diff.js";
import { shouldReviewFile, filterDuplicateComments } from "./filters.js";
import { generateReview, ReviewComment } from "./llm.js";
import { retrieveRules, formatRulesForPrompt } from "./rag.js";
import { recordReviewResult, determineRuleTitle } from "./persistence.js";

export type OctokitInstance = Context["octokit"];

export const MAX_FILES_PER_PR = 25;
export const MAX_TOTAL_DIFF_CHARS = 100_000;

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
  const { owner, repo, pullNumber, headSha, installationId } = params;
  const startTime = Date.now();

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
      if (diffsToReview.length >= MAX_FILES_PER_PR) {
        log.warn(
          `[WARN] Reached maximum review cap of ${MAX_FILES_PER_PR} files for PR #${pullNumber}. Skipping remaining files.`
        );
        break;
      }

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
      if (installationId) {
        await recordReviewResult({
          installationId,
          repo: `${owner}/${repo}`,
          prNumber: pullNumber,
          headSha,
          status: "completed",
          commentsPosted: 0,
          durationMs: Date.now() - startTime,
        });
      }
      return;
    }

    // Cap total diff character payload to prevent token overflow
    let totalDiffChars = 0;
    const cappedDiffsToReview: typeof diffsToReview = [];
    for (const d of diffsToReview) {
      if (totalDiffChars + d.diff.length > MAX_TOTAL_DIFF_CHARS && cappedDiffsToReview.length > 0) {
        log.warn(
          `[WARN] Reached maximum diff payload cap (${MAX_TOTAL_DIFF_CHARS} chars). Capping review files for PR #${pullNumber}.`
        );
        break;
      }
      totalDiffChars += d.diff.length;
      cappedDiffsToReview.push(d);
    }

    // 3. Retrieve relevant team style rules via pgvector RAG
    const diffSummary = diffsToReview
      .map((d) => `${d.filename}\n${d.diff}`)
      .join("\n")
      .slice(0, 2000);

    log.info(`Retrieving relevant style rules from pgvector for ${owner}/${repo}...`);
    const retrievedRules = await retrieveRules(diffSummary, 3, params.installationId);
    if (retrievedRules.length > 0) {
      log.info(`Retrieved ${retrievedRules.length} style rule(s): ${retrievedRules.map((r) => r.title).join(", ")}`);
    }
    const rulesPrompt = formatRulesForPrompt(retrievedRules);

    // 4. Ask Gemini to review the code with style guide awareness
    log.info(`Sending ${cappedDiffsToReview.length} file(s) to Gemini for review...`);
    const rawAiComments = await generateReview(cappedDiffsToReview, rulesPrompt, customApiKey);
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

      if (installationId) {
        await recordReviewResult({
          installationId,
          repo: `${owner}/${repo}`,
          prNumber: pullNumber,
          headSha,
          status: "completed",
          commentsPosted: 0,
          durationMs: Date.now() - startTime,
        });
      }
      return;
    }

    // Map comments to GitHub's Review API structure
    const githubComments = newComments.map((c) => ({
      path: c.file,
      line: c.line,
      side: "RIGHT" as const,
      body: `**[${c.severity.toUpperCase()}]** ${c.comment}`,
    }));

    const { data: createdReview } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: `🤖 **AI Pull Request Review**\nFound ${newComments.length} recommendation(s) in this pull request:`,
      comments: githubComments,
    });

    log.info(`[SUCCESS] Successfully posted AI review with ${newComments.length} comment(s)!`);

    // Fetch review comments to retrieve GitHub comment IDs
    let reviewCommentsOnGithub: any[] = [];
    if (createdReview?.id) {
      try {
        const { data: commentsList } = await octokit.rest.pulls.listCommentsForReview({
          owner,
          repo,
          pull_number: pullNumber,
          review_id: Number(createdReview.id),
        });
        reviewCommentsOnGithub = commentsList;
      } catch (err: any) {
        log.warn(`[WARN] Could not fetch GitHub comment IDs for review #${createdReview.id}: ${err?.message || err}`);
      }
    }

    if (installationId) {
      const persistedComments = newComments.map((c) => {
        const matched = reviewCommentsOnGithub.find(
          (gc) => gc.path === c.file && gc.line === c.line
        );
        const resolvedRuleTitle = determineRuleTitle(c, retrievedRules);
        return {
          file: c.file,
          line: c.line,
          severity: c.severity,
          comment: c.comment,
          rule_title: resolvedRuleTitle,
          githubCommentId: matched?.id || null,
        };
      });

      await recordReviewResult({
        installationId,
        repo: `${owner}/${repo}`,
        prNumber: pullNumber,
        headSha,
        status: "completed",
        commentsPosted: newComments.length,
        durationMs: Date.now() - startTime,
        comments: persistedComments,
      });
    }
  } catch (error: any) {
    log.error(`[ERROR] Review failed for PR #${pullNumber}:`, error);
    if (params.installationId) {
      const isRateLimit =
        String(error?.status) === "429" || String(error?.message).includes("429");
      await recordReviewResult({
        installationId: params.installationId,
        repo: `${owner}/${repo}`,
        prNumber: pullNumber,
        headSha,
        status: isRateLimit ? "rate_limited" : "error",
        commentsPosted: 0,
        error: error?.message || String(error),
        durationMs: Date.now() - startTime,
      });
    }
  }
}
