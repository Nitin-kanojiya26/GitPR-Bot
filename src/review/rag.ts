import { GoogleGenAI } from "@google/genai";
import pg from "pg";

export interface RetrievedRule {
  title: string;
  content: string;
  similarity: number;
}

/**
 * Pure helper function to format retrieved style guide rules for prompt injection.
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
 * Retrieves the top-K most semantically relevant style rules from pgvector.
 */
export async function retrieveRules(
  query: string,
  limit: number = 3
): Promise<RetrievedRule[]> {
  const apiKey = process.env.LLM_API_KEY;
  const dbUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/reviewbot";

  if (!apiKey) {
    console.warn("[WARN] LLM_API_KEY is not configured. Skipping rule retrieval.");
    return [];
  }

  if (!query || query.trim().length === 0) {
    return [];
  }

  const client = new pg.Client({ connectionString: dbUrl });

  try {
    // 1. Generate 768-dimensional embedding for query text
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: query,
      config: {
        outputDimensionality: 768,
      },
    });

    const embedding = response.embeddings?.[0]?.values;
    if (!embedding || embedding.length === 0) {
      console.warn("[WARN] Failed to compute embedding for retrieval query.");
      return [];
    }

    // 2. Query Postgres using cosine distance operator (<=>)
    await client.connect();

    const sql = `
      SELECT title, content, (1 - (embedding <=> $1::vector)) AS similarity
      FROM style_rules
      ORDER BY embedding <=> $1::vector
      LIMIT $2;
    `;

    const result = await client.query(sql, [JSON.stringify(embedding), limit]);

    return result.rows.map((row) => ({
      title: row.title,
      content: row.content,
      similarity: Number(row.similarity),
    }));
  } catch (error: any) {
    console.error("[ERROR] Rule retrieval failed:", error?.message || error);
    return [];
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore disconnect errors
    }
  }
}

