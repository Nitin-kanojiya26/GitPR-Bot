import { GoogleGenAI } from "@google/genai";
import { query } from "../db/client.js";
import { encryptApiKey, decryptApiKey } from "../security/crypto.js";

/**
 * Validates a user-supplied Google Gemini API key by making a lightweight 1-token test request.
 */
export async function testGeminiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey || apiKey.trim().length < 15) {
    return { valid: false, error: "API key is missing or too short." };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
    await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "ping",
      config: {
        maxOutputTokens: 1,
      },
    });
    return { valid: true };
  } catch (err: any) {
    const safeError = err?.message || String(err);
    return { valid: false, error: safeError.replace(apiKey, "[REDACTED_KEY]") };
  }
}

/**
 * Validates, encrypts with AES-256-GCM, and stores an installation's Gemini API key.
 */
export async function saveInstallationKey(
  installationId: number,
  plainApiKey: string
): Promise<{ success: boolean; last4: string; error?: string }> {
  // 1. Verify key works before storing
  const check = await testGeminiKey(plainApiKey);
  if (!check.valid) {
    return { success: false, last4: "", error: check.error || "Gemini key verification failed." };
  }

  // 2. Encrypt with random IV
  const { encryptedKey, ivAndTag, last4 } = encryptApiKey(plainApiKey);

  // 3. Persist to installation_settings
  await query(
    `UPDATE installation_settings
     SET encrypted_key = $1, key_iv_and_tag = $2, last4 = $3, updated_at = CURRENT_TIMESTAMP
     WHERE installation_id = $4;`,
    [encryptedKey, ivAndTag, last4, installationId]
  );

  return { success: true, last4 };
}

/**
 * Safely removes an installation's stored key.
 */
export async function deleteInstallationKey(installationId: number): Promise<void> {
  await query(
    `UPDATE installation_settings
     SET encrypted_key = NULL, key_iv_and_tag = NULL, last4 = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE installation_id = $1;`,
    [installationId]
  );
}

/**
 * Decrypts and retrieves the installation's Gemini API key for worker execution.
 * Returns null if no key is configured.
 */
export async function getDecryptedInstallationKey(installationId: number): Promise<string | null> {
  const result = await query(
    `SELECT encrypted_key, key_iv_and_tag
     FROM installation_settings
     WHERE installation_id = $1;`,
    [installationId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const { encrypted_key, key_iv_and_tag } = result.rows[0];
  if (!encrypted_key || !key_iv_and_tag) {
    return null;
  }

  try {
    return decryptApiKey(encrypted_key, key_iv_and_tag);
  } catch (err: any) {
    console.error(`[ERROR] Failed to decrypt API key for installation #${installationId}:`, err?.message || err);
    return null;
  }
}

/**
 * Retrieves setting summary for user dashboard / settings views.
 */
export async function getInstallationSettings(installationId: number) {
  const result = await query(
    `SELECT s.installation_id, s.last4, s.guide_md, s.guide_version, s.index_status, s.updated_at,
            i.account_login, i.account_type
     FROM installation_settings s
     JOIN installations i ON s.installation_id = i.installation_id
     WHERE s.installation_id = $1;`,
    [installationId]
  );

  return result.rows[0] || null;
}

/**
 * Checks if a "No Key Configured" warning comment was already posted for this repository.
 */
export async function hasPostedNoKeyWarning(repo: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM reviews WHERE repo = $1 AND status = 'no_key_warning' LIMIT 1;`,
    [repo]
  );
  return result.rows.length > 0;
}

/**
 * Records that a "No Key Configured" warning comment has been posted for a repository.
 */
export async function recordNoKeyWarning(
  installationId: number,
  repo: string,
  prNumber: number
): Promise<void> {
  // Ensure installation exists in installations table to prevent foreign key violation
  await query(
    `INSERT INTO installations (installation_id, account_login, account_type)
     VALUES ($1, 'unknown', 'User')
     ON CONFLICT (installation_id) DO NOTHING;`,
    [installationId]
  );

  await query(
    `INSERT INTO reviews (installation_id, repo, pr_number, head_sha, comments_posted, status)
     VALUES ($1, $2, $3, 'none', 1, 'no_key_warning');`,
    [installationId, repo, prNumber]
  );
}
