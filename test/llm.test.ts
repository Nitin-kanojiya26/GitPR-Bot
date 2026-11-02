import { describe, it, expect } from "vitest";
import { cleanJsonText, parseAndValidateReview, CommentSchema } from "../src/review/llm.js";

describe("LLM review validation", () => {
  it("cleans markdown json code fences", () => {
    const fenced = '```json\n{"comments": []}\n```';
    expect(cleanJsonText(fenced)).toBe('{"comments": []}');
  });

  it("successfully parses and validates good review JSON", () => {
    const goodJson = JSON.stringify({
      comments: [
        {
          file: "src/calc.js",
          line: 12,
          severity: "high",
          comment: "Potential divide-by-zero error if b is 0.",
        },
      ],
    });

    const comments = parseAndValidateReview(goodJson);
    expect(comments).toHaveLength(1);
    expect(comments[0].file).toBe("src/calc.js");
    expect(comments[0].line).toBe(12);
    expect(comments[0].severity).toBe("high");
  });

  it("returns empty array on malformed JSON without crashing", () => {
    const badJson = '{"comments": [ broken json...';
    expect(parseAndValidateReview(badJson)).toEqual([]);
  });

  it("rejects invalid line numbers (e.g. negative or 0)", () => {
    const invalidLine = JSON.stringify({
      comments: [
        {
          file: "calc.js",
          line: -5,
          severity: "low",
          comment: "Bad line",
        },
      ],
    });
    expect(parseAndValidateReview(invalidLine)).toEqual([]);
  });

  it("rejects invalid severity values", () => {
    const invalidSeverity = JSON.stringify({
      comments: [
        {
          file: "calc.js",
          line: 10,
          severity: "super-critical", // Not low, medium, or high
          comment: "Bad severity",
        },
      ],
    });
    expect(parseAndValidateReview(invalidSeverity)).toEqual([]);
  });
});