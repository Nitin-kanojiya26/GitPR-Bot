import fs from "node:fs";
import path from "node:path";
import { query, pool } from "../db/client.js";
import { embedText } from "../review/embed.js";

export interface ParsedRule {
  title: string;
  content: string;
}

/**
 * Loads the default style guide template from docs/style-guide.md.
 */
export function getDefaultGuideMarkdown(): string {
  const filePath = path.join(process.cwd(), "docs", "style-guide.md");
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return `# Team Style Guide\n\n## 1. Safe Code Execution\nNever use eval() or dynamic code execution.\n\n## 2. No Hardcoded Secrets\nNever commit API keys or passwords.`;
}

/**
 * Parses markdown into discrete rules by looking for '## ' section headers.
 * Enforces a 20,000 character cap and a maximum of 30 rules.
 */
export function parseGuideMarkdown(markdown: string): ParsedRule[] {
  if (!markdown || markdown.trim().length === 0) {
    return [];
  }

  if (markdown.length > 20000) {
    throw new Error(`Review guide exceeds maximum allowed length (20,000 characters). Current length: ${markdown.length}`);
  }

  const sections = markdown.split(/\n(?=##\s+)/);
  const rules: ParsedRule[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed.startsWith("##")) continue;

    const lines = trimmed.split("\n");
    const titleLine = lines[0].replace(/^##\s+/, "").trim();
    const content = lines.slice(1).join("\n").trim();

    if (titleLine && content) {
      rules.push({
        title: titleLine,
        content,
      });
    }

    if (rules.length >= 30) {
      break; // Cap at 30 rules
    }
  }

  return rules;
}

/**
 * Atomically updates an installation's rules: deletes old rules and inserts new embeddings.
 */
export async function syncInstallationRules(
  installationId: number | string,
  guideMarkdown: string
): Promise<{ success: boolean; ruleCount: number }> {
  const rules = parseGuideMarkdown(guideMarkdown);
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    // 1. Delete existing rules for this installation
    await client.query("DELETE FROM rules WHERE installation_id = $1;", [installationId]);

    // 2. Insert new embedded rules
    for (const rule of rules) {
      const fullText = `${rule.title}\n${rule.content}`;
      const embedding = await embedText(fullText);
      const vectorVal = embedding.length > 0 ? JSON.stringify(embedding) : null;

      await client.query(
        `INSERT INTO rules (installation_id, title, content, embedding)
         VALUES ($1, $2, $3, $4::vector);`,
        [installationId, rule.title, rule.content, vectorVal]
      );
    }

    // 3. Update settings record with markdown and indexed status
    await client.query(
      `UPDATE installation_settings
       SET guide_md = $1, index_status = 'indexed', updated_at = CURRENT_TIMESTAMP
       WHERE installation_id = $2;`,
      [guideMarkdown, installationId]
    );

    await client.query("COMMIT;");
    return { success: true, ruleCount: rules.length };
  } catch (err: any) {
    await client.query("ROLLBACK;");
    // Mark as failed in settings
    await client
      .query(
        "UPDATE installation_settings SET index_status = 'failed' WHERE installation_id = $1;",
        [installationId]
      )
      .catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Handles installation.created event: creates records and indexes default rules.
 */
export async function handleInstallationCreated(
  installationId: number,
  accountLogin: string,
  accountType: string
): Promise<void> {
  // 1. Record installation
  await query(
    `INSERT INTO installations (installation_id, account_login, account_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (installation_id) DO UPDATE
     SET account_login = EXCLUDED.account_login, account_type = EXCLUDED.account_type;`,
    [installationId, accountLogin, accountType]
  );

  // 2. Record default settings
  const defaultGuide = getDefaultGuideMarkdown();
  await query(
    `INSERT INTO installation_settings (installation_id, guide_md, index_status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (installation_id) DO NOTHING;`,
    [installationId, defaultGuide]
  );

  // 3. Sync default rules into pgvector
  try {
    await syncInstallationRules(installationId, defaultGuide);
    console.log(`[SUCCESS] [INSTALLATION] Initialized and indexed default rules for ${accountLogin} (#${installationId})`);
  } catch (err: any) {
    console.error(`[ERROR] [INSTALLATION] Failed indexing default rules for #${installationId}:`, err?.message || err);
  }
}

/**
 * Handles installation.deleted event: deletes tenant and cascades to all data.
 */
export async function handleInstallationDeleted(installationId: number): Promise<void> {
  const result = await query("DELETE FROM installations WHERE installation_id = $1;", [installationId]);
  console.log(`[INFO] [INSTALLATION] Purged tenant #${installationId} (deleted rows: ${result.rowCount})`);
}
