import { query } from "../db/client.js";
import { RetrievedRule } from "./rag.js";

export interface PersistedComment {
  file: string;
  line: number;
  severity: string;
  comment: string;
  rule_title?: string;
  githubCommentId?: number | null;
}

export interface RecordReviewOptions {
  installationId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  status: "completed" | "error" | "rate_limited" | "no_key_warning";
  commentsPosted: number;
  error?: string | null;
  durationMs?: number;
  comments?: PersistedComment[];
}

/**
 * Heuristically identifies the best matching rule title for a comment based on explicit field or text content.
 */
export function determineRuleTitle(
  comment: { comment: string; rule_title?: string },
  retrievedRules: RetrievedRule[] = []
): string {
  if (comment.rule_title && comment.rule_title.trim().length > 0) {
    return comment.rule_title.trim();
  }

  const commentLower = comment.comment.toLowerCase();

  for (const rule of retrievedRules) {
    const cleanTitle = rule.title.replace(/^\d+[\.\s]*/, "").trim().toLowerCase();
    if (commentLower.includes(cleanTitle) || commentLower.includes(rule.title.toLowerCase())) {
      return rule.title;
    }

    // Key topic matchers
    if (cleanTitle.includes("eval") && (commentLower.includes("eval") || commentLower.includes("dynamic"))) {
      return rule.title;
    }
    if (cleanTitle.includes("secret") && (commentLower.includes("secret") || commentLower.includes("api key") || commentLower.includes("credential"))) {
      return rule.title;
    }
    if (cleanTitle.includes("sql") && (commentLower.includes("sql") || commentLower.includes("query") || commentLower.includes("injection"))) {
      return rule.title;
    }
    if (cleanTitle.includes("timeout") && (commentLower.includes("timeout") || commentLower.includes("abort"))) {
      return rule.title;
    }
  }

  return "General Code Quality";
}

/**
 * Saves review execution log and individual comment records into PostgreSQL.
 */
export async function recordReviewResult(options: RecordReviewOptions): Promise<number | null> {
  const {
    installationId,
    repo,
    prNumber,
    headSha,
    status,
    commentsPosted,
    error,
    durationMs,
    comments = [],
  } = options;

  if (!installationId) {
    return null;
  }

  try {
    // 1. Ensure installation exists to prevent foreign key violation
    await query(
      `INSERT INTO installations (installation_id, account_login, account_type)
       VALUES ($1, 'unknown', 'User')
       ON CONFLICT (installation_id) DO NOTHING;`,
      [installationId]
    );

    // 2. Insert into reviews table
    const reviewResult = await query(
      `INSERT INTO reviews (
        installation_id, repo, pr_number, head_sha, comments_posted, status, error, duration_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id;`,
      [
        installationId,
        repo,
        prNumber,
        headSha,
        commentsPosted,
        status,
        error || null,
        durationMs || 0,
      ]
    );

    const reviewId = reviewResult.rows[0]?.id;

    // 3. Insert individual comments if review comments were posted
    if (reviewId && comments.length > 0) {
      for (const c of comments) {
        await query(
          `INSERT INTO comments (
            installation_id, review_id, github_comment_id, repo, pr_number,
            file, line, rule_title, severity, outcome, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', CURRENT_TIMESTAMP);`,
          [
            installationId,
            reviewId,
            c.githubCommentId || null,
            repo,
            prNumber,
            c.file,
            c.line,
            c.rule_title || "General Code Quality",
            c.severity,
          ]
        );
      }
    }

    return reviewId;
  } catch (err: any) {
    console.error("[ERROR] Failed to persist review result to database:", err?.message || err);
    return null;
  }
}
