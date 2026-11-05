import { query } from "../db/client.js";

/**
 * Marks review comments associated with resolved GitHub review threads as 'fixed'.
 */
export async function markThreadResolved(commentIds: (number | string)[]): Promise<number> {
  if (!commentIds || commentIds.length === 0) {
    return 0;
  }

  const numericIds = commentIds.map(Number).filter((id) => !isNaN(id) && id > 0);
  if (numericIds.length === 0) {
    return 0;
  }

  const result = await query(
    `UPDATE comments
     SET outcome = 'fixed', outcome_at = CURRENT_TIMESTAMP
     WHERE github_comment_id = ANY($1::bigint[]) AND outcome = 'open';`,
    [numericIds]
  );

  return result.rowCount || 0;
}

/**
 * Reverts comments back to 'open' if a previously resolved thread is reopened.
 */
export async function markThreadUnresolved(commentIds: (number | string)[]): Promise<number> {
  if (!commentIds || commentIds.length === 0) {
    return 0;
  }

  const numericIds = commentIds.map(Number).filter((id) => !isNaN(id) && id > 0);
  if (numericIds.length === 0) {
    return 0;
  }

  const result = await query(
    `UPDATE comments
     SET outcome = 'open', outcome_at = NULL
     WHERE github_comment_id = ANY($1::bigint[]) AND outcome = 'fixed';`,
    [numericIds]
  );

  return result.rowCount || 0;
}

/**
 * Marks any remaining 'open' comments as 'ignored' when a pull request is closed or merged.
 */
export async function markUnresolvedCommentsIgnored(
  repo: string,
  prNumber: number
): Promise<number> {
  if (!repo || !prNumber) {
    return 0;
  }

  const result = await query(
    `UPDATE comments
     SET outcome = 'ignored', outcome_at = CURRENT_TIMESTAMP
     WHERE repo = $1 AND pr_number = $2 AND outcome = 'open';`,
    [repo, prNumber]
  );

  return result.rowCount || 0;
}

/**
 * Calculates outcome counts and rates for an installation or set of installations.
 */
export async function getOutcomeStats(installationIds: number[]): Promise<{
  fixedCount: number;
  ignoredCount: number;
  openCount: number;
  fixedRatePercent: number;
  ignoredRatePercent: number;
}> {
  if (!installationIds || installationIds.length === 0) {
    return {
      fixedCount: 0,
      ignoredCount: 0,
      openCount: 0,
      fixedRatePercent: 0,
      ignoredRatePercent: 0,
    };
  }

  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE outcome = 'fixed') AS fixed_count,
       COUNT(*) FILTER (WHERE outcome = 'ignored') AS ignored_count,
       COUNT(*) FILTER (WHERE outcome = 'open') AS open_count
     FROM comments
     WHERE installation_id = ANY($1::bigint[]);`,
    [installationIds]
  );

  const row = result.rows[0] || {};
  const fixedCount = Number(row.fixed_count) || 0;
  const ignoredCount = Number(row.ignored_count) || 0;
  const openCount = Number(row.open_count) || 0;
  const decidedCount = fixedCount + ignoredCount;

  const fixedRatePercent = decidedCount > 0 ? Math.round((fixedCount / decidedCount) * 100) : 0;
  const ignoredRatePercent = decidedCount > 0 ? Math.round((ignoredCount / decidedCount) * 100) : 0;

  return {
    fixedCount,
    ignoredCount,
    openCount,
    fixedRatePercent,
    ignoredRatePercent,
  };
}
