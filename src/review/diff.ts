import parseDiff from "parse-diff";

/**
 * Returns a Set of line numbers (in the new file) that appear in the diff
 * and can legally receive inline review comments.
 */
export function getCommentableLines(patch: string): Set<number> {
  const commentable = new Set<number>();

  if (!patch) {
    return commentable;
  }

  const files = parseDiff(`--- a/file\n+++ b/file\n${patch}`);

  for (const file of files) {
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "add") {
          commentable.add(change.ln);
        } else if (change.type === "normal") {
          commentable.add(change.ln2);
        }
      }
    }
  }

  return commentable;
}

/**
 * Transforms a raw unified git patch into a string where every added and
 * context line is explicitly prefixed with its real new-file line number (e.g. L12: + code).
 */
export function numberedDiff(patch: string): string {
  if (!patch) return "";

  const [file] = parseDiff(`--- a/file\n+++ b/file\n${patch}`);
  const out: string[] = [];

  for (const chunk of file?.chunks ?? []) {
    out.push(chunk.content);
    for (const c of chunk.changes) {
      if (c.type === "add") {
        out.push(`L${c.ln}: + ${c.content.slice(1)}`);
      } else if (c.type === "normal") {
        out.push(`L${c.ln2}:   ${c.content.slice(1)}`);
      } else {
        // Deleted lines do not have a line number in the new file
        out.push(`      - ${c.content.slice(1)}`);
      }
    }
  }

  return out.join("\n");
}