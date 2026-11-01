import { describe, it, expect } from "vitest";
import { getCommentableLines } from "../src/review/diff.js";

describe("getCommentableLines", () => {
    it("should return valid line numbers for added and context lines", () => {
        const samplePatch = `@@ -1,3 +1,4 @@
 function add(a, b) {
-  return 0;
+  // Added validation
+  return a + b;
 }`;

        const lines = getCommentableLines(samplePatch);

        // Line 1: context line `function add(a, b) {`
        expect(lines.has(1)).toBe(true);
        // Line 2: added line `// Added validation`
        expect(lines.has(2)).toBe(true);
        // Line 3: added line `return a + b;`
        expect(lines.has(3)).toBe(true);
        // Line 4: context line `}`
        expect(lines.has(4)).toBe(true);

        // Line 99 does NOT exist in the diff
        expect(lines.has(99)).toBe(false);
    });

    it("should return an empty set if patch is empty", () => {
        const lines = getCommentableLines("");
        expect(lines.size).toBe(0);
    });
});