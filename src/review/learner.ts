import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import { cleanJsonText } from "./llm.js";

export interface ExtractedRule {
  isRule: boolean;
  title?: string;
  content?: string;
}

export interface LearnerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/**
 * Uses Google Gemini to analyze a review comment and determine if it expresses a reusable team rule.
 */
export async function extractRuleFromComment(
  commentBody: string,
  diffHunk?: string
): Promise<ExtractedRule> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || !commentBody || commentBody.trim().length < 10) {
    return { isRule: false };
  }

  const ai = new GoogleGenAI({ apiKey });
  const modelName = process.env.LLM_MODEL || "gemini-2.5-flash";

  const prompt = `You are an expert AI architect identifying reusable engineering standards and team conventions from code review comments.

REVIEW COMMENT:
"""
${commentBody.trim()}
"""

DIFF CONTEXT:
"""
${diffHunk ? diffHunk.slice(0, 1000) : "No diff context available"}
"""

INSTRUCTIONS:
1. Determine if this review comment teaches or enforces a REUSABLE team standard, convention, or architectural pattern for this codebase.
2. If it is purely situational, a one-off typo fix, or casual banter (e.g. 'LGTM', 'nice', 'typo on line 4'), return: {"isRule": false}.
3. If it IS a reusable rule (e.g., 'always use Zod', 'no raw SQL', 'wrap Redis in try-catch', 'use named exports', 'never use float for currency'), return:
   {"isRule": true, "title": "Concise Descriptive Title", "content": "1-2 sentences explaining what to do and why."}
4. Respond with valid JSON ONLY.`;

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const raw = response.text || "{}";
    const cleaned = cleanJsonText(raw);
    const parsed = JSON.parse(cleaned);

    if (parsed.isRule && parsed.title && parsed.content) {
      return {
        isRule: true,
        title: String(parsed.title).trim(),
        content: String(parsed.content).trim(),
      };
    }
    return { isRule: false };
  } catch (err: any) {
    console.error("[ERROR] Failed to extract rule from review comment:", err?.message || err);
    return { isRule: false };
  }
}

/**
 * Embeds and stores a learned team rule into pgvector tagged with the repository name.
 */
export async function saveTeamRule(
  repoFullName: string,
  title: string,
  content: string
): Promise<boolean> {
  const apiKey = process.env.LLM_API_KEY;
  const dbUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/reviewbot";

  if (!apiKey) {
    return false;
  }

  const client = new pg.Client({ connectionString: dbUrl });

  try {
    // 1. Generate 768-d embedding
    const ai = new GoogleGenAI({ apiKey });
    const ruleText = `${title}\n${content}`;
    const embedResponse = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: ruleText,
      config: {
        outputDimensionality: 768,
      },
    });

    const embedding = embedResponse.embeddings?.[0]?.values;
    if (!embedding || embedding.length === 0) {
      return false;
    }

    // 2. Persist to style_rules table
    await client.connect();

    const insertSql = `
      INSERT INTO style_rules (title, content, embedding, repo_full_name)
      VALUES ($1, $2, $3, $4);
    `;

    await client.query(insertSql, [
      title,
      content,
      JSON.stringify(embedding),
      repoFullName.toLowerCase(),
    ]);

    return true;
  } catch (err: any) {
    console.error("[ERROR] Failed to save learned team rule:", err?.message || err);
    return false;
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore disconnect error
    }
  }
}

/**
 * End-to-end handler: Learns from a human review comment if it contains a reusable rule.
 */
export async function learnFromReviewComment(
  repoFullName: string,
  commentBody: string,
  diffHunk?: string,
  log: LearnerLogger = console
): Promise<{ learned: boolean; title?: string }> {
  log.info(`[LEARNER] Inspecting review comment on ${repoFullName} for reusable standards...`);

  const extracted = await extractRuleFromComment(commentBody, diffHunk);
  if (!extracted.isRule || !extracted.title || !extracted.content) {
    log.info(`[LEARNER] Comment did not contain a reusable engineering rule.`);
    return { learned: false };
  }

  log.info(`[LEARNER] Identified candidate rule: "${extracted.title}"`);
  const saved = await saveTeamRule(repoFullName, extracted.title, extracted.content);

  if (saved) {
    log.info(
      `[SUCCESS] [LEARNER] Successfully learned and embedded rule "${extracted.title}" for ${repoFullName}!`
    );
    return { learned: true, title: extracted.title };
  }

  return { learned: false };
}
