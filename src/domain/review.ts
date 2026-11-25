/** The verdict of one review run, from the review agent's report. */
export type ReviewVerdict = "accepted" | "revision_needed" | "human_decision";

/** The verdicts the review agent is asked to state, before any synonym. */
const EXACT: [ReviewVerdict, RegExp][] = [
  ["human_decision", /\bhuman decision needed\b/i],
  ["revision_needed", /\brevision needed\b/i],
  ["accepted", /\baccepted\b/i],
];

const SYNONYMS: [ReviewVerdict, RegExp][] = [
  ["human_decision", /\bneeds? (?:a )?human decision\b|\bhuman decision\b/i],
  [
    "revision_needed",
    /\brevisions? needed\b|\bneeds? revisions?\b|\bchanges requested\b|\brequest(?:ing)? changes\b/i,
  ],
  ["accepted", /\b(?:approved|passed|lgtm)\b/i],
];

/** A negation in the verdict's clause before it: "not accepted", "never approved". */
const NEGATED = /\b(?:not|no|never)\b|n't\b/i;

function earliest(
  text: string,
  patterns: [ReviewVerdict, RegExp][],
): { verdict: ReviewVerdict; index: number } | null {
  let found: { verdict: ReviewVerdict; index: number } | null = null;
  for (const [verdict, pattern] of patterns) {
    const index = text.search(pattern);
    if (index >= 0 && (!found || index < found.index))
      found = { verdict, index };
  }
  return found;
}

/**
 * The verdict on the report's first line that starts with "Verdict"
 * ("Verdict: revision needed", "**Verdict:** accepted", or a "## Verdict"
 * heading with the verdict on the next line), or null when the report states
 * none or negates it: an unstated verdict is not guessed.
 */
export function reviewVerdict(report: string | null): ReviewVerdict | null {
  if (!report) return null;
  const lines = report.split("\n");
  const at = lines.findIndex((line) => /^\W*verdict\b/i.test(line));
  if (at < 0) return null;
  const clean = (line: string) =>
    line
      .replace(/^\W*verdict\b/i, "")
      .replace(/[*_`#>:\-—–|[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  // The verdict follows on the same line, or on the next one after a heading.
  const text =
    [clean(lines[at] ?? ""), ...lines.slice(at + 1).map(clean)].find(Boolean) ??
    "";
  const found = earliest(text, EXACT) ?? earliest(text, SYNONYMS);
  if (!found) return null;
  const clause = text.slice(0, found.index).split(/[,;.]/).at(-1) ?? "";
  return NEGATED.test(clause) ? null : found.verdict;
}
