import { embedText } from "./embed.js";
import { query as dbQuery } from "../db/client.js";

export interface RetrievedRule {
  title: string;
  content: string;
  similarity: number;
}

/**
 * Formats retrieved style guide rules for prompt injection.
 */
export function formatRulesForPrompt(rules: RetrievedRule[]): string {
  if (!rules || rules.length === 0) {
    return "";
  }

  const rulesText = rules
    .map((rule, idx) => `[Rule ${idx + 1}] ${rule.title}\n${rule.content}`)
    .join("\n\n");

  return `### RELEVANT TEAM STYLE GUIDE RULES:\nEnsure code complies with these team rules. If a rule is violated, cite its title in your comment.\n\n${rulesText}`;
}

/**
 * Retrieves the top-K most semantically relevant style rules from pgvector,
 * strictly scoped to the specific installation tenant.
 */
export async function retrieveRules(
  queryText: string,
  limit: number = 3,
  installationId?: number | string
): Promise<RetrievedRule[]> {
  if (!queryText || queryText.trim().length === 0) {
    return [];
  }

  if (!installationId) {
    return [];
  }

  try {
    // 1. Generate embedding using server-side embedder
    const embedding = await embedText(queryText);
    if (!embedding || embedding.length === 0) {
      return [];
    }

    // 2. Query Postgres rules table scoped strictly by installation_id
    const sql = `
      SELECT title, content, (1 - (embedding <=> $1::vector)) AS similarity
      FROM rules
      WHERE installation_id = $2 AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $3;
    `;

    const result = await dbQuery(sql, [
      JSON.stringify(embedding),
      installationId,
      limit,
    ]);

    return result.rows.map((row) => ({
      title: row.title,
      content: row.content,
      similarity: Number(row.similarity),
    }));
  } catch (error: any) {
    console.error("[ERROR] Rule retrieval failed:", error?.message || error);
    return [];
  }
}
