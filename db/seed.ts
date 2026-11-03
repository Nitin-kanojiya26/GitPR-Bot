import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import fs from "fs";
import path from "path";

// Load .env manually if needed
if (fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...v] = trimmed.split("=");
    if (key && !process.env[key.trim()]) process.env[key.trim()] = v.join("=").trim();
  }
}

const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/reviewbot";
const API_KEY = process.env.LLM_API_KEY;

if (!API_KEY) {
  console.error("[ERROR] LLM_API_KEY is missing from .env");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const client = new pg.Client({ connectionString: DATABASE_URL });

interface RuleChunk {
  title: string;
  content: string;
}

/**
 * Splits docs/style-guide.md into chunks based on "## " Markdown headings.
 */
function parseStyleGuide(markdown: string): RuleChunk[] {
  const sections = markdown.split(/\n(?=##\s+)/);
  const chunks: RuleChunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed.startsWith("##")) continue;

    const firstLineEnd = trimmed.indexOf("\n");
    const title = trimmed.slice(2, firstLineEnd !== -1 ? firstLineEnd : undefined).trim();
    const content = firstLineEnd !== -1 ? trimmed.slice(firstLineEnd).trim() : "";

    chunks.push({ title, content });
  }

  return chunks;
}

async function seed() {
  console.log("[INFO] Starting style guide database seed...");

  await client.connect();

  // 1. Ensure schema and vector extension exist
  const schemaPath = path.resolve("./db/schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await client.query(schemaSql);
  console.log("[INFO] Schema initialized with vector extension.");

  // 2. Clear old rules to ensure idempotent re-runs
  await client.query("TRUNCATE TABLE style_rules;");

  // 3. Read and parse style guide
  const guidePath = path.resolve("./docs/style-guide.md");
  const guideContent = fs.readFileSync(guidePath, "utf8");
  const rules = parseStyleGuide(guideContent);
  console.log(`[INFO] Found ${rules.length} rules in docs/style-guide.md`);

  // 4. Generate embeddings and insert into Postgres
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const textToEmbed = `${rule.title}\n\n${rule.content}`;

    console.log(`[INFO] Embedding rule [${i + 1}/${rules.length}]: "${rule.title}"...`);

    const response = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: textToEmbed,
      config: {
        outputDimensionality: 768,
      },
    });

    const embedding = response.embeddings?.[0]?.values;
    if (!embedding) {
      console.error(`[ERROR] Failed to get embedding for rule: ${rule.title}`);
      continue;
    }

    // Insert into pgvector
    await client.query(
      "INSERT INTO style_rules (title, content, embedding) VALUES ($1, $2, $3::vector)",
      [rule.title, rule.content, JSON.stringify(embedding)]
    );
  }

  console.log(`\n[SUCCESS] Successfully embedded and stored ${rules.length} rules into pgvector!`);
  await client.end();
}

seed().catch((err) => {
  console.error("[ERROR] Seed failed:", err);
  client.end();
  process.exit(1);
});
