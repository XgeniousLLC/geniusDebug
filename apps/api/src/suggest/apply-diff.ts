/**
 * Apply a unified diff to file content deterministically (FR-AIF P4). Throws if
 * any hunk's context/removed lines don't match the current file — that abort is
 * the "context drift" guard: we never open a PR from a patch that no longer
 * applies cleanly to the branch. No fuzz, no model in this path.
 */
export function applyUnifiedDiff(original: string, diff: string): string {
  const src = original.split('\n');
  const out: string[] = [];
  let cursor = 0; // 0-based index into src

  const lines = diff.split('\n');
  let i = 0;
  let appliedHunk = false;

  const hunkRe = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/;

  while (i < lines.length) {
    const line = lines[i];
    // Skip file headers / git noise between hunks.
    if (!line.startsWith('@@')) {
      i++;
      continue;
    }
    const m = hunkRe.exec(line);
    if (!m) throw new Error(`malformed hunk header: ${line}`);
    const oldStart = parseInt(m[1], 10); // 1-based

    // Copy unchanged lines before this hunk.
    const hunkStart = oldStart - 1;
    if (hunkStart < cursor) throw new Error('overlapping or out-of-order hunks');
    while (cursor < hunkStart) {
      if (cursor >= src.length) throw new Error('hunk starts past end of file');
      out.push(src[cursor++]);
    }

    i++; // move past the @@ line
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const h = lines[i];
      const marker = h[0];
      const content = h.slice(1);
      if (marker === '+') {
        out.push(content); // added line
      } else if (marker === '-') {
        if (src[cursor] !== content) {
          throw new Error(`context mismatch at line ${cursor + 1}: expected removed "${content}", found "${src[cursor] ?? '<eof>'}"`);
        }
        cursor++; // consume removed line
      } else if (marker === ' ' || marker === undefined) {
        // context (a bare empty diff line is empty context)
        if (src[cursor] !== content) {
          throw new Error(`context mismatch at line ${cursor + 1}: expected "${content}", found "${src[cursor] ?? '<eof>'}"`);
        }
        out.push(src[cursor++]);
      } else if (marker === '\\') {
        // "\ No newline at end of file" — ignore
      } else {
        throw new Error(`unexpected diff line: ${h}`);
      }
    }
    appliedHunk = true;
  }

  if (!appliedHunk) throw new Error('no hunks found in diff');

  // Copy the remainder of the file.
  while (cursor < src.length) out.push(src[cursor++]);
  return out.join('\n');
}
