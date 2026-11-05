import { query } from "../db/client.js";

export interface CommentPerWeek {
  week: string;
  count: number;
}

export interface TopRule {
  rule_title: string;
  count: number;
}

export interface OutcomeRates {
  fixed_count: number;
  ignored_count: number;
  open_count: number;
  fixed_rate: number;
  ignored_rate: number;
}

export interface RecentReview {
  id: number;
  repo: string;
  pr_number: number;
  head_sha: string;
  comments_posted: number;
  status: string;
  duration_ms: number;
  created_at: Date;
}

export interface DashboardData {
  commentsPerWeek: CommentPerWeek[];
  topRules: TopRule[];
  outcomeRates: OutcomeRates;
  recentReviews: RecentReview[];
  hasData: boolean;
}

/**
 * Fetches all four dashboard panels in parallel, strictly filtered by tenant installation IDs.
 */
export async function getDashboardData(installationIds: number[]): Promise<DashboardData> {
  if (!installationIds || installationIds.length === 0) {
    return {
      commentsPerWeek: [],
      topRules: [],
      outcomeRates: {
        fixed_count: 0,
        ignored_count: 0,
        open_count: 0,
        fixed_rate: 0,
        ignored_rate: 0,
      },
      recentReviews: [],
      hasData: false,
    };
  }

  // 1. Comments per week (last 12 weeks)
  const commentsPerWeekPromise = query(
    `SELECT
       to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
       COUNT(*)::int AS count
     FROM comments
     WHERE installation_id = ANY($1::bigint[])
       AND created_at >= CURRENT_TIMESTAMP - INTERVAL '12 weeks'
     GROUP BY date_trunc('week', created_at)
     ORDER BY date_trunc('week', created_at) ASC;`,
    [installationIds]
  );

  // 2. Top 5 rules triggered
  const topRulesPromise = query(
    `SELECT
       COALESCE(rule_title, 'General Code Quality') AS rule_title,
       COUNT(*)::int AS count
     FROM comments
     WHERE installation_id = ANY($1::bigint[])
     GROUP BY rule_title
     ORDER BY count DESC
     LIMIT 5;`,
    [installationIds]
  );

  // 3. Fixed vs Ignored percentage with NULLIF zero-division defense
  const outcomeRatesPromise = query(
    `SELECT
       COUNT(*) FILTER (WHERE outcome = 'fixed')::int AS fixed_count,
       COUNT(*) FILTER (WHERE outcome = 'ignored')::int AS ignored_count,
       COUNT(*) FILTER (WHERE outcome = 'open')::int AS open_count,
       COALESCE(
         ROUND(
           (COUNT(*) FILTER (WHERE outcome = 'fixed')::numeric /
            NULLIF(COUNT(*) FILTER (WHERE outcome IN ('fixed', 'ignored')), 0)) * 100,
           1
         ),
         0
       )::float AS fixed_rate,
       COALESCE(
         ROUND(
           (COUNT(*) FILTER (WHERE outcome = 'ignored')::numeric /
            NULLIF(COUNT(*) FILTER (WHERE outcome IN ('fixed', 'ignored')), 0)) * 100,
           1
         ),
         0
       )::float AS ignored_rate
     FROM comments
     WHERE installation_id = ANY($1::bigint[]);`,
    [installationIds]
  );

  // 4. Recent 20 reviews table
  const recentReviewsPromise = query(
    `SELECT
       id,
       repo,
       pr_number,
       head_sha,
       comments_posted,
       status,
       duration_ms,
       created_at
     FROM reviews
     WHERE installation_id = ANY($1::bigint[])
     ORDER BY created_at DESC
     LIMIT 20;`,
    [installationIds]
  );

  const [commentsPerWeekRes, topRulesRes, outcomeRatesRes, recentReviewsRes] =
    await Promise.all([
      commentsPerWeekPromise,
      topRulesPromise,
      outcomeRatesPromise,
      recentReviewsPromise,
    ]);

  const commentsPerWeek: CommentPerWeek[] = commentsPerWeekRes.rows.map((r) => ({
    week: r.week,
    count: Number(r.count),
  }));

  const topRules: TopRule[] = topRulesRes.rows.map((r) => ({
    rule_title: r.rule_title,
    count: Number(r.count),
  }));

  const outcomeRatesRow = outcomeRatesRes.rows[0] || {};
  const outcomeRates: OutcomeRates = {
    fixed_count: Number(outcomeRatesRow.fixed_count) || 0,
    ignored_count: Number(outcomeRatesRow.ignored_count) || 0,
    open_count: Number(outcomeRatesRow.open_count) || 0,
    fixed_rate: Number(outcomeRatesRow.fixed_rate) || 0,
    ignored_rate: Number(outcomeRatesRow.ignored_rate) || 0,
  };

  const recentReviews: RecentReview[] = recentReviewsRes.rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    pr_number: r.pr_number,
    head_sha: r.head_sha,
    comments_posted: r.comments_posted,
    status: r.status,
    duration_ms: r.duration_ms,
    created_at: r.created_at,
  }));

  const hasData =
    commentsPerWeek.length > 0 ||
    topRules.length > 0 ||
    recentReviews.length > 0 ||
    outcomeRates.open_count > 0;

  return {
    commentsPerWeek,
    topRules,
    outcomeRates,
    recentReviews,
    hasData,
  };
}

