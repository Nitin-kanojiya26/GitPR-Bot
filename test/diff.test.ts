import { describe, it, expect } from "vitest";
import { getCommentableLines, numberedDiff } from "../src/review/diff.js";

describe("diff utilities", () => {
  const samplePatch = `@@ -10,3 +10,4 @@
 function add(a, b) {
-  return 0;
+  // Added validation
+  return a + b;
 }`;

  describe("getCommentableLines", () => {
    it("should return valid line numbers for added and context lines", () => {
      const lines = getCommentableLines(samplePatch);
      expect(lines.has(10)).toBe(true);
      expect(lines.has(11)).toBe(true);
      expect(lines.has(12)).toBe(true);
      expect(lines.has(13)).toBe(true);
      expect(lines.has(99)).toBe(false);
    });

    it("should return an empty set if patch is empty", () => {
      const lines = getCommentableLines("");
      expect(lines.size).toBe(0);
    });
  });

  describe("numberedDiff", () => {
    it("should prefix lines with their real line numbers", () => {
      const result = numberedDiff(samplePatch);

      expect(result).toContain("L10:   function add(a, b) {");
      expect(result).toContain("      -   return 0;");
      expect(result).toContain("L11: +   // Added validation");
      expect(result).toContain("L12: +   return a + b;");
      expect(result).toContain("L13:   }");
    });

    it("should return empty string if patch is empty", () => {
      expect(numberedDiff("")).toBe("");
    });
  });
});