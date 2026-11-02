#!/usr/bin/env node
/**
 * Independent review of one pull request by a second model, in a macOS sandbox.
 *
 *   node bin/review.ts --pr <n> [--spec <file>] [--declined <file>] [--post | --no-post]
 *
 * Run it from any checkout of the repository. It:
 *   1. reads the PR (gh) and fetches its base and head; nothing is checked out;
 *   2. exports the PR head (`git archive`: no .git, nothing gitignored) into a scratch copy, minus
 *      the repository's private-data paths, binaries and huge files; builds the request from the
 *      diff of the shareable files, the spec (PR body, the GitHub issues it closes, --spec) and the
 *      previous round with the author's declines;
 *   3. runs the configured backend (pi, claude or codex) in that copy, inside `sandbox-exec`:
 *      outside the copy, the backend's own files and review.readPaths, nothing under the home
 *      folder, the temp folders or external volumes can be read, and writes stay in the copy;
 *   4. validates the reply, downgrades blocking findings without proof, re-runs each run proof in
 *      the reviewer's copy (exit 0 = not reproduced = not blocking), and saves the round plus the
 *      reviewer's repro files as a patch under ~/.local/state/nstack/review/<owner>/<repo>/pr-<n>/;
 *   5. posts the round on the PR when review.post is "comment" (or --post), never with --no-post.
 *
 * Exit 0 = valid review (the verdict is inside), 1 = usage/git/gh error, 2 = the reviewer failed
 * or its reply broke the schema, 3 = the round limit is reached (a human decides).
 * A round can take 5–20 minutes: run it in the background.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS, loadConfig, readOptional, repoRoot } from "../lib/config.ts";
import { BACKENDS } from "../review/backends.ts";
import {
  ReviewError,
  applyReruns,
  assertNoSecrets,
  closedIssues,
  finalVerdict,
  gateBlocking,
  isText,
  parseReview,
  renderComment,
  sandboxProfile,
  shareable,
} from "../review/core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GH = process.env.NSTACK_GH ?? "gh";
const SANDBOX = "/usr/bin/sandbox-exec";
const STATE = process.env.NSTACK_REVIEW_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "nstack/review");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function run(cwd: string, cmd: string, args: string[], input?: string): string {
  const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new ReviewError(1, `${cmd} ${args.slice(0, 4).join(" ")}: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
}

/** Size of a path's blob at a revision; 0 when absent there and `optional`. */
function sizeAt(repo: string, rev: string, path: string, optional = false): number {
  const r = spawnSync("git", ["cat-file", "-s", `${rev}:${path}`], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    if (optional) return 0;
    throw new ReviewError(1, `git cat-file ${rev}:${path}: ${r.stderr.trim()}`);
  }
  return Number(r.stdout.trim());
}

function main(scratch: string): void {
  const pr = arg("pr");
  if (!pr || !/^\d+$/.test(pr)) throw new ReviewError(1, "usage: --pr <n> [--spec <file>] [--declined <file>] [--post | --no-post]");
  const repo = repoRoot(process.cwd());
  if (!repo) throw new ReviewError(1, "run it from a checkout of the repository");
  const cfg = loadConfig(repo);
  const model = process.env.NSTACK_REVIEW_MODEL ?? cfg.review.model ?? DEFAULT_MODELS[cfg.review.backend];

  const info = JSON.parse(run(repo, GH, ["pr", "view", pr, "--json", "baseRefName,headRefOid,title,body,url"]));
  const slug = new URL(info.url).pathname.split("/").slice(1, 3).join("/");
  const base = `origin/${info.baseRefName}`;
  const head: string = info.headRefOid;
  const out = join(STATE, slug, `pr-${pr}`);
  mkdirSync(out, { recursive: true });
  const done = readdirSync(out).filter((f) => /^round-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)![0]));
  const round = done.length ? Math.max(...done) + 1 : 1;
  if (round > cfg.review.maxRounds) {
    throw new ReviewError(3, `round ${round} would pass the limit of ${cfg.review.maxRounds}: a human decides what remains (${out})`);
  }

  run(repo, "git", ["fetch", "-q", "origin", info.baseRefName, `pull/${pr}/head`]);
  // Every changed path, deletions included (-z keeps names raw). Private data, binaries and huge
  // files are named but never sent, on either side of the diff.
  const fields = run(repo, "git", ["diff", "-z", "--name-status", "--no-renames", `${base}...${head}`]).split("\0");
  const changed: { path: string; exists: boolean; ok: boolean }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, path] = [fields[i], fields[i + 1]];
    const exists = status !== "D";
    const size = Math.max(exists ? sizeAt(repo, head, path) : 0, sizeAt(repo, base, path, true));
    changed.push({ path, exists, ok: shareable(path, size, cfg.data) });
  }
  if (!changed.length) throw new ReviewError(1, `empty diff against ${base}`);
  const literal = changed.filter((f) => f.ok).map((f) => `:(literal)${f.path}`);
  const diff = literal.length ? run(repo, "git", ["diff", "--no-color", "--no-renames", `${base}...${head}`, "--", ...literal]) : "";
  if (!isText(diff)) throw new ReviewError(1, "the shareable diff contains binary content");
  const withheld = changed.filter((f) => !f.ok).map((f) => f.path);

  let spec = `# PR #${pr}: ${info.title}\n\n${info.body ?? ""}\n`;
  const issues = cfg.tracker === "github" ? closedIssues(info.body ?? "") : [];
  for (const n of issues) {
    const issue = JSON.parse(run(repo, GH, ["issue", "view", n, "--json", "number,title,body"]));
    spec += `\n\n# Issue #${issue.number}: ${issue.title}\n\n${issue.body}\n`;
  }
  const specFile = arg("spec");
  if (specFile) spec += `\n\n# Ticket\n\n${readFileSync(specFile, "utf8")}\n`;

  // The reviewer's own copy: the PR head as committed, minus what may not leave this machine.
  const tree = join(scratch, "tree");
  const tmp = join(scratch, "tmp");
  mkdirSync(tree);
  mkdirSync(tmp);
  const tar = spawnSync("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", head, tree], { cwd: repo, encoding: "utf8" });
  if (tar.status !== 0) throw new ReviewError(1, `git archive: ${tar.stderr}`);
  for (const entry of run(repo, "git", ["ls-tree", "-r", "-z", "-l", head]).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]) || 0;
    const local = join(tree, path);
    if (!existsSync(local)) continue;
    if (!shareable(path, size, cfg.data) || !isText(readFileSync(local, "latin1"))) rmSync(local, { force: true });
  }
  // A private baseline of the copy, so the reviewer's repro files can be handed to the author.
  const snap = ["--git-dir", join(scratch, "baseline.git"), "--work-tree", tree];
  run(scratch, "git", ["init", "-q", "--bare", join(scratch, "baseline.git")]);
  run(scratch, "git", [...snap, "add", "-A"]);
  run(scratch, "git", [...snap, "-c", "user.name=nstack", "-c", "user.email=nstack@localhost", "commit", "-q", "--allow-empty", "-m", "baseline"]);

  const previous = round > 1 ? readOptional(join(out, `round-${round - 1}.json`)) : null;
  const declinedFile = arg("declined") ?? (round > 1 ? join(out, `round-${round - 1}.declined.json`) : null);
  const declined = readOptional(declinedFile);
  const sandboxed = existsSync(SANDBOX) && process.env.NSTACK_REVIEW_SANDBOX !== "0";
  if (!sandboxed && process.env.NSTACK_REVIEW_UNSANDBOXED !== "1") {
    throw new ReviewError(1, "no sandbox-exec here: set NSTACK_REVIEW_UNSANDBOXED=1 to review without one (the reviewer can then read the whole machine)");
  }

  const readPaths = cfg.review.readPaths
    .map((p) => (isAbsolute(p) ? p : resolve(repo, p)))
    .filter(existsSync)
    .map((p) => realpathSync(p));
  const parts = [
    `Review pull request #${pr} of ${slug}, round ${round}. Your working directory is your copy of the repository at the PR head; read it freely for context.`,
    cfg.review.run
      ? "You may run commands and write files in your copy to prove findings. Use TMPDIR for anything temporary."
      : "Do not run commands or write files: this repository's review is read-only, so blocking findings can only be quote-proved.",
    readPaths.length ? `Also readable for running code (toolchains, environments): ${readPaths.join(", ")}` : "",
    `Write titles, details and suggestions in ${cfg.language}.`,
    cfg.proof ? `How changes prove themselves in this repository: ${cfg.proof}` : "",
    withheld.length ? `Changed but withheld from you (private data, binary or too large): ${withheld.join(", ")}` : "",
    issues.length || specFile ? "" : "The PR closes no issue: judge issue fit from its description only.",
    `## Diff (\`git diff ${base}...HEAD\`, shareable files only)\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``,
    `## Spec\n\n${spec}`,
    previous ? `## Previous round\n\n\`\`\`json\n${previous}\n\`\`\`` : "",
    declined ? `## Findings the author declined, with reasons\n\n\`\`\`json\n${declined}\n\`\`\`` : "",
    "Reply with the single JSON object only.",
  ];
  const prompt = parts.filter(Boolean).join("\n\n");
  const promptFile = join(scratch, "request.md");
  writeFileSync(promptFile, prompt);
  writeFileSync(join(out, `round-${round}.request.md`), prompt);

  const rubric = [readFileSync(join(HERE, "../review/rubric.md"), "utf8"), readOptional(cfg.rubric)].filter(Boolean).join("\n\n# This repository\n\n");
  const inv = BACKENDS[cfg.review.backend]({ tree, scratch, rubric, prompt, promptFile, model, run: cfg.review.run });
  const realScratch = realpathSync(scratch);
  const profile = sandboxProfile(realpathSync(homedir()), [...inv.read, ...readPaths], [realScratch, ...inv.write]);
  const env = { ...process.env, ...inv.env, TMPDIR: join(realScratch, "tmp") };
  const wrap = (cmd: string, args: string[]): [string, string[]] => (sandboxed ? [SANDBOX, ["-p", profile, cmd, ...args]] : [cmd, args]);

  const [cmd, args] = wrap(inv.cmd, inv.args);
  const r = spawnSync(cmd, args, { cwd: tree, env, input: inv.stdin ?? "", encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 40 * 60_000 });
  writeFileSync(join(out, `round-${round}.log`), (r.stdout ?? "") + "\n--- stderr ---\n" + (r.stderr ?? ""));
  if (r.status !== 0) throw new ReviewError(2, `${cfg.review.backend} exited ${r.status ?? r.signal}: ${(r.stderr ?? "").trim().slice(0, 2000)}`);

  const reply = inv.reply(r.stdout ?? "");
  const secrets = inv.secrets();
  assertNoSecrets(reply, secrets);
  const review = gateBlocking(parseReview(reply));

  // Re-run each blocking run proof in the reviewer's copy, under the same sandbox (no backend files).
  const reruns: Record<string, { code: number | null; output: string }> = {};
  const rerunProfile = sandboxProfile(realpathSync(homedir()), readPaths, [realScratch]);
  for (const f of review.findings) {
    if (f.severity !== "blocking" || f.proof?.kind !== "run") continue;
    const [c, a] = sandboxed ? [SANDBOX, ["-p", rerunProfile, "sh", "-c", f.proof.command]] : ["sh", ["-c", f.proof.command]];
    const rr = spawnSync(c, a, { cwd: tree, env: { ...process.env, TMPDIR: join(realScratch, "tmp") }, encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    const output = `${rr.stdout ?? ""}${rr.stderr ?? ""}`.slice(-4000);
    assertNoSecrets(output, secrets);
    reruns[f.id] = { code: rr.status, output };
  }
  finalVerdict(applyReruns(review, reruns));

  run(scratch, "git", [...snap, "add", "-A"]);
  const patch = run(scratch, "git", [...snap, "diff", "--cached", "--binary"]);
  if (patch.trim()) {
    assertNoSecrets(patch, secrets);
    writeFileSync(join(out, `round-${round}.proof.patch`), patch);
  }
  review.meta = { pr: Number(pr), repo: slug, round, base, head, backend: cfg.review.backend, model, maxRounds: cfg.review.maxRounds };
  const file = join(out, `round-${round}.json`);
  writeFileSync(file, JSON.stringify(review, null, 2) + "\n");
  const body = join(out, `round-${round}.comment.md`);
  writeFileSync(body, renderComment(review, round, head, `${cfg.review.backend} · ${model}`));
  process.stdout.write(JSON.stringify(review, null, 2) + "\n");
  process.stderr.write(
    `review: ${review.verdict}, ${review.findings.length} findings → ${file}` + (patch.trim() ? ` (repro files: round-${round}.proof.patch)` : "") + "\n",
  );

  const post = process.argv.includes("--post") || (cfg.review.post === "comment" && !process.argv.includes("--no-post"));
  if (post) run(repo, GH, ["pr", "comment", pr, "--body-file", body]);
}

const scratch = mkdtempSync(join(tmpdir(), "nstack-review-"));
let code = 0;
try {
  main(scratch);
} catch (e) {
  code = e instanceof ReviewError ? e.code : 2;
  process.stderr.write(`review: ${e instanceof Error ? e.message : String(e)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(code);
