import pg from "pg";

const dbUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/reviewbot";
const client = new pg.Client({ connectionString: dbUrl });

async function seed() {
  await client.connect();
  console.log("[INFO] Connected to PostgreSQL. Seeding sample metrics...");

  const instId = 5567905;

  // 1. Seed Installation
  await client.query(`
    INSERT INTO installations (installation_id, account_login, account_type)
    VALUES ($1, 'demo-team', 'Organization')
    ON CONFLICT (installation_id) DO UPDATE
    SET account_login = EXCLUDED.account_login;
  `, [instId]);

  // 2. Seed Settings
  await client.query(`
    INSERT INTO installation_settings (installation_id, last4, guide_version, index_status, updated_at)
    VALUES ($1, '4321', 1, 'indexed', CURRENT_TIMESTAMP)
    ON CONFLICT (installation_id) DO UPDATE
    SET last4 = '4321', index_status = 'indexed';
  `, [instId]);

  // Clean old sample reviews for this installation
  await client.query("DELETE FROM reviews WHERE installation_id = $1;", [instId]);

  // 3. Seed Reviews
  const rev1 = await client.query(`
    INSERT INTO reviews (installation_id, repo, pr_number, head_sha, comments_posted, status, duration_ms, created_at)
    VALUES ($1, 'demo-team/backend-api', 42, 'a1b2c3d4e5', 3, 'completed', 1820, CURRENT_TIMESTAMP - INTERVAL '1 day')
    RETURNING id;
  `, [instId]);

  const rev2 = await client.query(`
    INSERT INTO reviews (installation_id, repo, pr_number, head_sha, comments_posted, status, duration_ms, created_at)
    VALUES ($1, 'demo-team/auth-service', 89, 'e2d14cb89a', 2, 'completed', 1420, CURRENT_TIMESTAMP - INTERVAL '3 days')
    RETURNING id;
  `, [instId]);

  const rev3 = await client.query(`
    INSERT INTO reviews (installation_id, repo, pr_number, head_sha, comments_posted, status, duration_ms, created_at)
    VALUES ($1, 'demo-team/web-frontend', 104, 'c89e1fa012', 0, 'completed', 920, CURRENT_TIMESTAMP - INTERVAL '5 days')
    RETURNING id;
  `, [instId]);

  const rev4 = await client.query(`
    INSERT INTO reviews (installation_id, repo, pr_number, head_sha, comments_posted, status, duration_ms, created_at)
    VALUES ($1, 'demo-team/data-pipeline', 56, 'b4317ac678', 2, 'completed', 2150, CURRENT_TIMESTAMP - INTERVAL '8 days')
    RETURNING id;
  `, [instId]);

  const rev5 = await client.query(`
    INSERT INTO reviews (installation_id, repo, pr_number, head_sha, comments_posted, status, duration_ms, created_at)
    VALUES ($1, 'demo-team/payments-api', 142, '7f3a9bc432', 1, 'rate_limited', 310, CURRENT_TIMESTAMP - INTERVAL '12 days')
    RETURNING id;
  `, [instId]);

  // 4. Seed Comments
  const comments = [
    { reviewId: rev1.rows[0].id, repo: 'demo-team/backend-api', pr: 42, file: 'src/calc.js', line: 12, rule: 'Safe Code Execution (Never Use eval)', severity: 'critical', outcome: 'fixed', daysAgo: 1 },
    { reviewId: rev1.rows[0].id, repo: 'demo-team/backend-api', pr: 42, file: 'src/config.ts', line: 45, rule: 'No Hardcoded Secrets or Credentials', severity: 'critical', outcome: 'fixed', daysAgo: 1 },
    { reviewId: rev1.rows[0].id, repo: 'demo-team/backend-api', pr: 42, file: 'src/fetcher.ts', line: 18, rule: 'Network Requests Must Have Timeouts', severity: 'medium', outcome: 'open', daysAgo: 1 },
    { reviewId: rev2.rows[0].id, repo: 'demo-team/auth-service', pr: 89, file: 'src/db.ts', line: 60, rule: 'Parameterized SQL Queries', severity: 'high', outcome: 'fixed', daysAgo: 3 },
    { reviewId: rev2.rows[0].id, repo: 'demo-team/auth-service', pr: 89, file: 'src/validator.ts', line: 102, rule: 'Strict Input Validation', severity: 'low', outcome: 'ignored', daysAgo: 3 },
    { reviewId: rev4.rows[0].id, repo: 'demo-team/data-pipeline', pr: 56, file: 'src/runner.py', line: 33, rule: 'Safe Code Execution (Never Use eval)', severity: 'critical', outcome: 'ignored', daysAgo: 8 },
    { reviewId: rev4.rows[0].id, repo: 'demo-team/data-pipeline', pr: 56, file: 'src/auth.py', line: 77, rule: 'No Hardcoded Secrets or Credentials', severity: 'high', outcome: 'open', daysAgo: 8 },
  ];

  for (const c of comments) {
    await client.query(`
      INSERT INTO comments (installation_id, review_id, repo, pr_number, file, line, rule_title, severity, outcome, created_at, outcome_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP - ($10 || ' days')::interval, CURRENT_TIMESTAMP);
    `, [instId, c.reviewId, c.repo, c.pr, c.file, c.line, c.rule, c.severity, c.outcome, c.daysAgo]);
  }

  console.log(`[SUCCESS] Seeded demo installation #${instId} with 5 reviews and ${comments.length} comments!`);
  await client.end();
}

seed().catch((err) => {
  console.error("[ERROR] Failed to seed demo metrics:", err);
  process.exit(1);
});

