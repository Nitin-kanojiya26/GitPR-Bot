import { query } from "../db/client.js";

export const HOURLY_REVIEW_LIMIT = 20;

/**
 * Checks if a GitHub webhook delivery ID has already been received.
 * Atomically records it in PostgreSQL. Returns true if first time, false if duplicate.
 */
export async function recordWebhookDelivery(deliveryId: string): Promise<boolean> {
  if (!deliveryId) {
    return true; // No delivery ID present, allow processing
  }

  try {
    const result = await query(
      `INSERT INTO webhook_deliveries (delivery_id, received_at)
       VALUES ($1, CURRENT_TIMESTAMP)
       ON CONFLICT (delivery_id) DO NOTHING;`,
      [deliveryId]
    );

    // If rowCount is 1, delivery was inserted; if 0, it was already present
    return (result.rowCount || 0) > 0;
  } catch (err: any) {
    console.warn(`[WARN] Failed to record webhook delivery idempotency: ${err?.message || err}`);
    return true; // Fail open on DB error so reviews aren't blocked
  }
}

/**
 * Periodically deletes webhook delivery entries older than 24 hours to prevent table bloat.
 */
export async function cleanOldWebhookDeliveries(): Promise<number> {
  try {
    const result = await query(
      `DELETE FROM webhook_deliveries
       WHERE received_at < CURRENT_TIMESTAMP - INTERVAL '24 hours';`
    );
    return result.rowCount || 0;
  } catch {
    return 0;
  }
}

/**
 * Enforces per-installation hourly review cap (max 20 reviews per rolling hour).
 */
export async function checkInstallationHourlyCap(installationId: number): Promise<{
  allowed: boolean;
  currentCount: number;
}> {
  if (!installationId) {
    return { allowed: true, currentCount: 0 };
  }

  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count
       FROM reviews
       WHERE installation_id = $1
         AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour';`,
      [installationId]
    );

    const currentCount = Number(result.rows[0]?.count) || 0;
    return {
      allowed: currentCount < HOURLY_REVIEW_LIMIT,
      currentCount,
    };
  } catch {
    return { allowed: true, currentCount: 0 };
  }
}

/**
 * Checks whether an identical commit SHA has already been reviewed for this PR.
 */
export async function isCommitAlreadyReviewed(
  repo: string,
  prNumber: number,
  headSha: string
): Promise<boolean> {
  if (!repo || !prNumber || !headSha) {
    return false;
  }

  try {
    const result = await query(
      `SELECT 1 FROM reviews
       WHERE repo = $1 AND pr_number = $2 AND head_sha = $3 AND status = 'completed'
       LIMIT 1;`,
      [repo, prNumber, headSha]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}
