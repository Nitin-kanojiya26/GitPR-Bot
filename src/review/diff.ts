import parseDiff from "parse-diff";

export function getCommentableLines(patch: string): Set<number> {
    const commentable = new Set<number>();

    if (!patch) {
        return commentable;
    }

    // parse-diff expects a full unified diff header, so we prepend standard a/b prefixes
    const files = parseDiff(`--- a/file\n+++ b/file\n${patch}`);

    for (const file of files) {
        for (const chunk of file.chunks) {
            for (const change of chunk.changes) {
                // "add" = a new line (+)
                // "normal" = an unchanged context line inside the diff chunk
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