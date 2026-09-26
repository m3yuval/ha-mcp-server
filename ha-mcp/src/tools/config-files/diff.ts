/**
 * Tiny unified line diff (no dependency). Common prefix/suffix are trimmed
 * first; the changed middle is diffed with an LCS table when it is small
 * enough, otherwise it is shown as one replaced block. Good enough for
 * reviewing config edits, which are usually small.
 */

type Op = { t: " " | "-" | "+"; line: string };

const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((line) => ({ t: " ", line }));
  if (am.length * bm.length <= MAX_LCS_CELLS) {
    const n = am.length;
    const m = bm.length;
    // lcs[i][j] = LCS length of am[i..] and bm[j..], stored flat
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          am[i] === bm[j]
            ? lcs[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: " ", line: am[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
        ops.push({ t: "-", line: am[i++] });
      } else {
        ops.push({ t: "+", line: bm[j++] });
      }
    }
    while (i < n) ops.push({ t: "-", line: am[i++] });
    while (j < m) ops.push({ t: "+", line: bm[j++] });
  } else {
    for (const line of am) ops.push({ t: "-", line });
    for (const line of bm) ops.push({ t: "+", line });
  }
  for (const line of a.slice(a.length - suf)) ops.push({ t: " ", line });
  return ops;
}

/**
 * Unified diff of two texts. Returns "" when identical. Output is capped at
 * maxLines lines (a note says how many were cut).
 */
export function unifiedDiff(oldText: string, newText: string, name: string, context = 3, maxLines = 400): string {
  if (oldText === newText) return "";
  const ops = lineOps(splitLines(oldText), splitLines(newText));
  const out: string[] = [`--- a/${name}`, `+++ b/${name}`];
  // Walk ops, grouping changes (with context) into hunks.
  let k = 0;
  let aLine = 1;
  let bLine = 1;
  const pos: { a: number; b: number }[] = ops.map((op) => {
    const p = { a: aLine, b: bLine };
    if (op.t !== "+") aLine++;
    if (op.t !== "-") bLine++;
    return p;
  });
  while (k < ops.length) {
    while (k < ops.length && ops[k].t === " ") k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    // extend the hunk while the next change is within 2*context of the last one
    let last = k;
    for (let i = k; i < ops.length; i++) {
      if (ops[i].t !== " ") last = i;
      else if (i - last > 2 * context) break;
    }
    const end = Math.min(ops.length - 1, last + context);
    const hunk = ops.slice(start, end + 1);
    const aCount = hunk.filter((o) => o.t !== "+").length;
    const bCount = hunk.filter((o) => o.t !== "-").length;
    const aStart = aCount ? pos[start].a : pos[start].a - 1;
    const bStart = bCount ? pos[start].b : pos[start].b - 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    k = end + 1;
  }
  if (!oldText.endsWith("\n") && oldText !== "" && !newText.endsWith("\n") && newText !== "") {
    // both lack a trailing newline: nothing to flag
  } else if (oldText.endsWith("\n") !== newText.endsWith("\n") && oldText !== "" && newText !== "") {
    out.push("\\ trailing newline changed");
  }
  if (out.length > maxLines) {
    const cut = out.length - maxLines;
    return out.slice(0, maxLines).join("\n") + `\n… [diff truncated: ${cut} more lines]`;
  }
  return out.join("\n");
}

/** Count of added / removed lines, for a compact summary. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}
