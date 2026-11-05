import { GoogleGenAI } from "@google/genai";

/**
 * Small, provider-agnostic interface for generating text embeddings.
 * Embeddings are computed server-side using the bot's configured key,
 * ensuring users do not need to provide an API key for embedding indexing.
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || !text || text.trim().length === 0) {
    return [];
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: {
      outputDimensionality: 768,
    },
  });

  return response.embeddings?.[0]?.values || [];
}

/**
 * Batch generates embeddings for multiple text strings.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    const vec = await embedText(text);
    results.push(vec);
  }
  return results;
}
