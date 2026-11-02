const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");

if (fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...v] = trimmed.split("=");
    if (key) process.env[key.trim()] = v.join("=").trim();
  }
}

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) {
  console.error("LLM_API_KEY not found in .env");
  process.exit(1);
}

const modelName = process.env.LLM_MODEL || "gemini-2.0-flash";
console.log(`Testing Gemini API connection with model: ${modelName}...`);

const ai = new GoogleGenAI({ apiKey });

async function run() {
  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: "Say 'Gemini is connected and ready to review code!' in one sentence.",
    });

    console.log("\nGemini replied successfully:");
    console.log(`"${response.text ? response.text.trim() : JSON.stringify(response)}"`);
  } catch (err) {
    console.error("\nError connecting to Gemini:");
    if (err.status) console.error(`HTTP Status: ${err.status}`);
    console.error(err.message || err);
  }
}

run();
