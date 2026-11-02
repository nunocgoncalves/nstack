/**
 * Pure parts of the independent review: what may be sent to the reviewer, how its reply is
 * validated, which findings keep their severity, how a round is rendered, and the macOS sandbox
 * profile. No I/O, so it is tested without git, gh or a model.
 */

export class ReviewError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Text source by extension or well-known name. Anything else (binaries, archives, drawings,
 * spreadsheets, unknown formats) is named to the reviewer but never sent.
 */
const TEXT =
  /\.(py|pyi|ts|tsx|mts|cts|js|mjs|cjs|jsx|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|sql|css|scss|html|vue|svelte|md|mdx|txt|rst|toml|ya?ml|cfg|ini|conf|sh|bash|zsh|fish|json|jsonc|graphql|proto|tf|hcl|nix|svg|xml|csv)$|(^|\/)(Dockerfile|Makefile|Justfile|Procfile|Gemfile|\.gitignore|\.gitattributes|\.editorconfig|requirements[^/]*\.txt|go\.mod|go\.sum|Cargo\.lock|uv\.lock|bun\.lock)$/i;
export const FILE_LIMIT = 300_000;

/** May this path's content reach the reviewer? `data` are the repository's never-send prefixes. */
export function shareable(path: string, size: number, data: string[]): boolean {
  const norm = path.replace(/^\.\//, "");
  if (data.some((d) => norm === d.replace(/\/$/, "") || norm.startsWith(d.endsWith("/") ? d : `${d}/`))) return false;
  return TEXT.test(norm) && size <= FILE_LIMIT;
}

/** A NUL byte means binary, whatever the extension says. */
export function isText(content: string): boolean {
  return !content.includes("\0");
}

/** GitHub issue numbers a PR body closes. */
export function closedIssues(body: string): string[] {
  return [...new Set([...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => m[1]))];
}

export const SEVERITIES = ["blocking", "should-fix", "nit"] as const;
export const CATEGORIES = ["correctness", "proof", "security", "issue-fit", "structure", "performance"] as const;
const STATES = ["met", "unmet", "unclear"];

function text(v: unknown, field: string, empty = false): string {
  if (typeof v !== "string" || (!empty && !v.trim())) throw new ReviewError(2, `${field}: missing text`);
  return v;
}

/** The first balanced top-level JSON object in a reply (models sometimes wrap it in prose). */
export function extractJson(reply: string): any {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  try {
    if (start < 0 || end < start) throw new Error();
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new ReviewError(2, `the reply is not JSON: ${reply.slice(0, 300)}`);
  }
}

/** Parse and fully validate the reviewer's reply against the rubric's schema. */
export function parseReview(reply: string): any {
  const r = extractJson(reply);
  if (!["ready", "changes_required"].includes(r?.verdict)) throw new ReviewError(2, "invalid verdict");
  text(r.summary, "summary");
  if (!Array.isArray(r.findings)) throw new ReviewError(2, "findings is not a list");
  const ids = new Set<string>();
  r.findings.forEach((f: any, i: number) => {
    const at = `findings[${i}]`;
    if (typeof f !== "object" || f === null) throw new ReviewError(2, `${at}: not an object`);
    text(f.id, `${at}.id`);
    if (ids.has(f.id)) throw new ReviewError(2, `${at}.id repeated: ${f.id}`);
    ids.add(f.id);
    if (!SEVERITIES.includes(f.severity)) throw new ReviewError(2, `${at}.severity invalid`);
    if (!CATEGORIES.includes(f.category)) throw new ReviewError(2, `${at}.category invalid`);
    text(f.title, `${at}.title`);
    text(f.detail, `${at}.detail`);
    text(f.suggestion, `${at}.suggestion`);
    for (const k of ["file", "line", "lint_rule", "proof"]) {
      if (!(k in f)) throw new ReviewError(2, `${at}.${k} missing (may be null)`);
    }
    if (f.file !== null) text(f.file, `${at}.file`);
    if (f.line !== null && !(Number.isInteger(f.line) && f.line > 0)) throw new ReviewError(2, `${at}.line invalid`);
    if (f.severity === "nit") text(f.lint_rule, `${at}.lint_rule (required on a nit)`);
    else if (f.lint_rule !== null && typeof f.lint_rule !== "string") throw new ReviewError(2, `${at}.lint_rule invalid`);
    if (f.proof !== null) {
      const p = f.proof;
      if (typeof p !== "object" || !["run", "quote"].includes(p.kind)) throw new ReviewError(2, `${at}.proof.kind must be "run" or "quote"`);
      if (p.kind === "run") {
        text(p.command, `${at}.proof.command`);
        text(p.output, `${at}.proof.output`, true);
      } else {
        text(p.quote, `${at}.proof.quote`);
      }
    }
  });
  if (!Array.isArray(r.resolved) || r.resolved.some((x: unknown) => typeof x !== "string")) {
    throw new ReviewError(2, "resolved must be a list of ids");
  }
  if (!Array.isArray(r.acceptance)) throw new ReviewError(2, "acceptance is not a list");
  r.acceptance.forEach((a: any, i: number) => {
    text(a?.criterion, `acceptance[${i}].criterion`);
    if (!STATES.includes(a.status)) throw new ReviewError(2, `acceptance[${i}].status invalid`);
    text(a.evidence ?? "", `acceptance[${i}].evidence`, true);
  });
  return r;
}

/** Categories where reading is proof enough: a leak is visible in the text, an unmet criterion in the spec. */
const QUOTE_PROVES = new Set(["security", "issue-fit", "proof"]);

/**
 * Blocking needs proof. A blocking finding keeps its severity only with a run proof (a command
 * that exits non-zero because of the defect) or, for a leak or an unmet criterion, a quote of
 * the offending text. Anything else becomes should-fix, with the reason recorded.
 */
export function gateBlocking(r: any): any {
  for (const f of r.findings) {
    if (f.severity !== "blocking") continue;
    const p = f.proof;
    const ok = p?.kind === "run" || (p?.kind === "quote" && QUOTE_PROVES.has(f.category));
    if (!ok) {
      f.severity = "should-fix";
      f.downgraded = p ? `a quote does not prove a ${f.category} defect; only a run does` : "no proof given";
    }
  }
  return r;
}

/**
 * After the runner re-ran each run proof in the reviewer's tree: a command that now exits 0 did
 * not reproduce the defect, so the finding cannot block.
 */
export function applyReruns(r: any, reruns: Record<string, { code: number | null; output: string }>): any {
  for (const f of r.findings) {
    const rr = reruns[f.id];
    if (!rr) continue;
    f.proof.rerun = rr;
    if (f.severity === "blocking" && rr.code === 0) {
      f.severity = "should-fix";
      f.downgraded = "the proof command exited 0 when re-run: the defect was not reproduced";
    }
  }
  return r;
}

/** The verdict follows the findings, never the model's wording. */
export function finalVerdict(r: any): any {
  r.verdict = r.findings.some((f: any) => f.severity === "blocking") ? "changes_required" : "ready";
  return r;
}

const fence = (s: string) => {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
};

export function renderComment(r: any, round: number, head: string, model: string): string {
  const label: Record<string, string> = { blocking: "🔴 blocking", "should-fix": "🟠 should-fix", nit: "⚪ nit" };
  const lines = [
    `### Independent review — round ${round} (\`${head.slice(0, 7)}\`)`,
    "",
    `**${r.verdict === "ready" ? "Ready" : "Changes required"}.** ${r.summary}`,
    "",
  ];
  for (const f of r.findings) {
    const where = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
    lines.push(`- ${label[f.severity]} **${f.id}**${where} — ${f.title}`, `  ${f.detail}`, `  _Fix:_ ${f.suggestion}`);
    if (f.downgraded) lines.push(`  _Not blocking:_ ${f.downgraded}.`);
    if (f.proof?.kind === "run") {
      const out = (f.proof.rerun?.output ?? f.proof.output).slice(-1500);
      const exit = f.proof.rerun ? ` (re-run: exit ${f.proof.rerun.code})` : "";
      const fc = fence(f.proof.command + out);
      lines.push(`  <details><summary>Proof${exit}</summary>`, "", `  ${fc}`, `  $ ${f.proof.command}`, ...out.split("\n").map((l: string) => `  ${l}`), `  ${fc}`, "  </details>");
    } else if (f.proof?.kind === "quote") {
      lines.push(...f.proof.quote.split("\n").map((l: string) => `  > ${l}`));
    }
  }
  if (r.resolved.length) lines.push("", `Resolved since the previous round: ${r.resolved.join(", ")}`);
  if (r.acceptance.length) {
    lines.push("", "| Criterion | Status | Evidence |", "|---|---|---|");
    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    for (const a of r.acceptance) lines.push(`| ${cell(a.criterion)} | ${a.status} | ${cell(a.evidence ?? "")} |`);
  }
  lines.push("", `<sub>nstack review · ${model}</sub>`);
  return lines.join("\n") + "\n";
}

/** Quoted for an SBPL string literal. */
function sbpl(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * macOS sandbox profile for the reviewer. Reads under the home folder, the temp folders and
 * external volumes are denied except `read` (and `write`, which is also readable), apart from
 * file metadata (stat), which interpreters need to resolve their own paths; writes are
 * allowed only in `write`. Everything else (system tools, the network for the model) stays open.
 * Paths must be real paths: the sandbox matches on them, not on symlinks.
 */
export function sandboxProfile(home: string, read: string[], write: string[]): string {
  const sub = (ps: string[]) => ps.map((p) => `(subpath ${sbpl(p)})`).join(" ");
  const closed = `(subpath ${sbpl(home)}) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/Volumes")`;
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${closed})`,
    // stat() anywhere: interpreters resolve their own paths (a virtualenv's parent folder).
    // It reveals that a path exists and its size, never its content or a folder's listing.
    "(allow file-read-metadata)",
    `(allow file-read* (literal ${sbpl(home)}) ${sub([...read, ...write])})`,
    `(deny file-write* ${closed})`,
    write.length ? `(allow file-write* ${sub(write)})` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Every string value in a credentials file long enough to be a secret. */
export function secretsIn(json: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.length >= 16) out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(json));
  } catch {
    // unreadable: nothing to look for
  }
  return out;
}

/** The reviewer can read its own credentials inside the sandbox: never let them out in a review. */
export function assertNoSecrets(text: string, secrets: string[]): void {
  if (secrets.some((s) => text.includes(s))) throw new ReviewError(2, "the review contains a reviewer credential: not saved or posted");
}
