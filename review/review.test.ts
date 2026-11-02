import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../lib/config.ts";
import { claudeReply, piReply } from "./backends.ts";
import {
  ReviewError,
  applyReruns,
  assertNoSecrets,
  closedIssues,
  finalVerdict,
  gateBlocking,
  parseReview,
  renderComment,
  sandboxProfile,
  secretsIn,
  shareable,
} from "./core.ts";

const finding = (o: Record<string, unknown> = {}) => ({
  id: "F1",
  severity: "should-fix",
  category: "correctness",
  file: "a.py",
  line: 1,
  title: "t",
  detail: "d",
  suggestion: "s",
  lint_rule: null,
  proof: null,
  ...o,
});
const review = (findings: unknown[] = []) => ({ verdict: "ready", summary: "ok.", findings, resolved: [], acceptance: [] });

function events(...msgs: { text: string; stop?: string }[]): string {
  return msgs
    .map((m) => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: m.stop ?? "stop", content: [{ type: "text", text: m.text }] } }))
    .join("\n");
}

describe("backend replies", () => {
  it("pi: only the final message, only when it stopped normally", () => {
    assert.equal(piReply(events({ text: "a" }, { text: "b" })), "b");
    assert.throws(() => piReply(events({ text: "a" }, { text: "b", stop: "error" })), ReviewError);
    assert.throws(() => piReply(events({ text: "a" }) + '\n{"type":"agent_settled","aborted":true}'), ReviewError);
    assert.throws(() => piReply(""), ReviewError);
  });
  it("claude: the result of a successful run", () => {
    assert.equal(claudeReply('{"type":"result","subtype":"success","is_error":false,"result":"{}"}'), "{}");
    assert.throws(() => claudeReply('{"type":"result","subtype":"error_max_turns","is_error":true}'), ReviewError);
    assert.throws(() => claudeReply("not json"), ReviewError);
  });
});

describe("schema", () => {
  it("accepts a complete review and rejects missing or invalid fields", () => {
    assert.equal(parseReview(JSON.stringify(review([finding()]))).findings.length, 1);
    const { proof: _, ...noProof } = finding();
    assert.throws(() => parseReview(JSON.stringify(review([noProof]))), /proof missing/);
    assert.throws(() => parseReview(JSON.stringify(review([finding({ severity: "nit" })]))), /lint_rule/);
    assert.throws(() => parseReview(JSON.stringify(review([finding(), finding()]))), /repeated/);
    assert.throws(() => parseReview(JSON.stringify(review([finding({ proof: { kind: "vibes" } })]))), /proof.kind/);
    assert.throws(() => parseReview(JSON.stringify({ ...review(), acceptance: "x" })), /acceptance/);
    assert.throws(() => parseReview("no json here"), /not JSON/);
  });
});

describe("blocking needs proof", () => {
  const gate = (f: Record<string, unknown>) => finalVerdict(gateBlocking(parseReview(JSON.stringify(review([finding({ severity: "blocking", ...f })])))));
  it("no proof: downgraded, verdict ready", () => {
    const r = gate({});
    assert.equal(r.findings[0].severity, "should-fix");
    assert.match(r.findings[0].downgraded, /no proof/);
    assert.equal(r.verdict, "ready");
  });
  it("a run proof keeps it blocking", () => {
    assert.equal(gate({ proof: { kind: "run", command: "false", output: "" } }).verdict, "changes_required");
  });
  it("a quote proves a leak or an unmet criterion, not a logic bug", () => {
    assert.equal(gate({ category: "security", proof: { kind: "quote", quote: "token=abc" } }).verdict, "changes_required");
    assert.equal(gate({ category: "issue-fit", proof: { kind: "quote", quote: "criterion" } }).verdict, "changes_required");
    assert.equal(gate({ category: "correctness", proof: { kind: "quote", quote: "x = 1" } }).verdict, "ready");
  });
  it("a proof that exits 0 when re-run is not reproduced", () => {
    const r = gateBlocking(parseReview(JSON.stringify(review([finding({ severity: "blocking", proof: { kind: "run", command: "true", output: "FAIL" } })]))));
    finalVerdict(applyReruns(r, { F1: { code: 0, output: "ok" } }));
    assert.equal(r.verdict, "ready");
    assert.match(r.findings[0].downgraded, /not reproduced/);
  });
  it("the verdict follows the findings, not the model's word", () => {
    assert.equal(finalVerdict(gateBlocking(parseReview(JSON.stringify({ ...review(), verdict: "changes_required" })))).verdict, "ready");
  });
});

describe("what may reach the reviewer", () => {
  it("text source only, never private data, never huge", () => {
    assert.equal(shareable("src/a.py", 10, []), true);
    assert.equal(shareable("drawing.dxf", 10, []), false);
    assert.equal(shareable("data/catalog.json", 10, ["data/"]), false);
    assert.equal(shareable("data", 10, ["data/"]), false);
    assert.equal(shareable("database.py", 10, ["data/"]), true);
    assert.equal(shareable("src/a.py", 10_000_000, []), false);
  });
  it("closed issues from the PR body", () => {
    assert.deepEqual(closedIssues("Closes #3, fixes #4 and resolves #3. See #9."), ["3", "4"]);
  });
  it("credentials never leave in a review", () => {
    const s = secretsIn(JSON.stringify({ p: { access: "tok_0123456789abcdefXYZ", expires: 1 } }));
    assert.deepEqual(s, ["tok_0123456789abcdefXYZ"]);
    assert.throws(() => assertNoSecrets("… tok_0123456789abcdefXYZ …", s), ReviewError);
  });
  it("renders a comment with proof and downgrade notes", () => {
    const r = finalVerdict(gateBlocking(parseReview(JSON.stringify(review([finding({ severity: "blocking" })])))));
    const c = renderComment(r, 2, "abcdef1234", "pi · m");
    assert.match(c, /round 2 \(`abcdef1`\)/);
    assert.match(c, /Not blocking:_ no proof given/);
  });
});

describe("config", () => {
  it("defaults, validation and relative paths", () => {
    const d = parseConfig({}, null);
    assert.equal(d.tracker, "github");
    assert.equal(d.ticketPrefix, "GH");
    assert.equal(d.review.backend, "pi");
    assert.equal(d.review.maxRounds, 3);
    const c = parseConfig({ tracker: "linear", ticketPrefix: "HOR", rubric: "rubric.md", review: { backend: "codex" } }, "/x/.nstack");
    assert.equal(c.rubric, "/x/.nstack/rubric.md");
    assert.throws(() => parseConfig({ tracker: "linear" }, null), /ticketPrefix/);
    assert.throws(() => parseConfig({ trackr: "github" }, null), /unknown field/);
    assert.throws(() => parseConfig({ review: { backend: "gpt" } }, null), /backend/);
  });
});

describe("sandbox", { skip: !existsSync("/usr/bin/sandbox-exec") && "macOS only" }, () => {
  it("reads and writes only where allowed", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nstack-sandbox-")));
    const ok = join(root, "tree");
    const no = join(root, "other");
    mkdirSync(ok);
    mkdirSync(no);
    writeFileSync(join(ok, "ok.txt"), "yes\n");
    writeFileSync(join(no, "secret.txt"), "DATA\n");
    const profile = sandboxProfile(realpathSync(homedir()), [], [ok]);
    const sb = (...a: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, ...a], { encoding: "utf8" });
    assert.equal(sb("/bin/cat", join(ok, "ok.txt")).stdout, "yes\n");
    assert.notEqual(sb("/bin/cat", join(no, "secret.txt")).status, 0);
    assert.notEqual(sb("/bin/ls", homedir()).stdout.includes(".ssh"), true);
    assert.equal(sb("/usr/bin/touch", join(ok, "new")).status, 0);
    assert.notEqual(sb("/usr/bin/touch", join(no, "x")).status, 0);
  });
});

// ---- bin/review.ts end to end, with a fake gh and a fake pi ----

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), "../bin/review.ts");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A repo with a PR #7 against dev, private data in it, and fakes that answer with `reply`. */
function setup(reply: string, config: object = { data: ["private/"], review: { post: "comment" } }, piScript = "") {
  const root = mkdtempSync(join(tmpdir(), "nstack-review-test-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "-q", "--bare", origin);
  git(root, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  mkdirSync(join(repo, ".nstack"));
  writeFileSync(join(repo, ".nstack/config.json"), JSON.stringify(config));
  writeFileSync(join(repo, ".nstack/rubric.md"), "REPO RUBRIC SECTION\n");
  writeFileSync(join(repo, "a.py"), "x = 1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/dev");
  writeFileSync(join(repo, "a.py"), "x = 2\n");
  mkdirSync(join(repo, "private"));
  writeFileSync(join(repo, "private/catalog.json"), '{"PRIVATE DATA": 1}\n');
  writeFileSync(join(repo, "*.json"), "{}\n");
  writeFileSync(join(repo, "ação.md"), "accents\n");
  writeFileSync(join(repo, "fake.py"), "PRIVATE DATA\0binary\n");
  writeFileSync(join(repo, "drawing.dxf"), "PRIVATE DATA\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "change");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "HEAD:refs/pull/7/head");

  const log = join(root, "gh.log");
  const gh = join(root, "gh");
  const view = { baseRefName: "dev", headRefOid: head, title: "t", body: "Closes #3", url: "https://github.com/o/r/pull/7" };
  writeFileSync(
    gh,
    `#!/bin/sh\necho "$@" >> ${log}\ncase "$1 $2" in\n` +
      `  "pr view") echo '${JSON.stringify(view)}' ;;\n` +
      `  "issue view") echo '{"number":3,"title":"the issue","body":"CRITERION"}' ;;\n` +
      `  "pr comment") ;;\n  *) exit 9 ;;\nesac\n`,
  );
  const pi = join(root, "pi");
  const args = join(root, "pi.args");
  writeFileSync(join(root, "pi.out"), reply);
  writeFileSync(
    pi,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${args}\nfor a in "$@"; do case "$a" in @*) cat "\${a#@}" > ${args}.request ;; esac; done\nls -A > ${args}.tree\n${piScript}\ncat ${join(root, "pi.out")}\n`,
  );
  chmodSync(gh, 0o755);
  chmodSync(pi, 0o755);
  const env = {
    ...process.env,
    NSTACK_GH: gh,
    NSTACK_PI: pi,
    NSTACK_REVIEW_DIR: join(root, "state"),
    // the fakes live in a temp folder the sandbox closes; the sandbox has its own test above
    NSTACK_REVIEW_SANDBOX: "0",
    NSTACK_REVIEW_UNSANDBOXED: "1",
  };
  const state = join(root, "state/o/r/pr-7");
  return { root, repo, env, log, args, state };
}

const runReview = (t: { repo: string; env: NodeJS.ProcessEnv }, ...extra: string[]) =>
  spawnSync(process.execPath, [REVIEW, "--pr", "7", ...extra], { cwd: t.repo, env: t.env, encoding: "utf8" });

describe("bin/review.ts", () => {
  it("reviews, saves, posts, and never sends private data", () => {
    const t = setup(events({ text: JSON.stringify(review()) }));
    const r = runReview(t);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "ready");
    const request = readFileSync(`${t.args}.request`, "utf8");
    assert.match(request, /x = 2/);
    assert.match(request, /CRITERION/);
    assert.match(request, /accents/);
    assert.doesNotMatch(request, /PRIVATE DATA/);
    assert.match(request, /withheld.*drawing\.dxf/);
    const tree = readFileSync(`${t.args}.tree`, "utf8");
    assert.doesNotMatch(tree, /drawing\.dxf|fake\.py/);
    assert.ok(!existsSync(join(t.root, "private")));
    const args = readFileSync(t.args, "utf8");
    assert.match(args, /--no-context-files/);
    assert.match(args, /REPO RUBRIC SECTION/);
    assert.match(args, /bash/);
    assert.match(readFileSync(t.log, "utf8"), /pr comment 7/);
    assert.ok(existsSync(join(t.state, "round-1.json")));
  });

  it("--no-post keeps the round local", () => {
    const t = setup(events({ text: JSON.stringify(review()) }));
    assert.equal(runReview(t, "--no-post").status, 0);
    assert.doesNotMatch(readFileSync(t.log, "utf8"), /pr comment/);
  });

  it("re-runs proofs in the reviewer's copy and hands over its repro files", () => {
    const blocking = (id: string, command: string) => finding({ id, severity: "blocking", proof: { kind: "run", command, output: "FAIL" } });
    const t = setup(
      events({ text: JSON.stringify(review([blocking("F1", "sh .review/repro.sh"), blocking("F2", "true")])) }),
      { review: { post: "none" } },
      "mkdir -p .review && printf 'exit 1\\n' > .review/repro.sh",
    );
    const r = runReview(t);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, "changes_required");
    assert.equal(out.findings[0].severity, "blocking");
    assert.equal(out.findings[0].proof.rerun.code, 1);
    assert.equal(out.findings[1].severity, "should-fix");
    assert.match(readFileSync(join(t.state, "round-1.proof.patch"), "utf8"), /\.review\/repro\.sh/);
  });

  it("round 2 gets round 1 and the author's declines; the round limit stops it", () => {
    const t = setup(events({ text: JSON.stringify(review()) }), { review: { maxRounds: 2, post: "none" } });
    assert.equal(runReview(t).status, 0);
    writeFileSync(join(t.state, "round-1.declined.json"), '[{"id":"F9","reason":"DECLINED BECAUSE"}]');
    assert.equal(runReview(t).status, 0);
    const request = readFileSync(`${t.args}.request`, "utf8");
    assert.match(request, /Previous round/);
    assert.match(request, /DECLINED BECAUSE/);
    assert.equal(runReview(t).status, 3);
  });

  it("a reply outside the schema exits 2 with no round saved and nothing posted", () => {
    const t = setup(events({ text: '{"verdict":"ready","findings":[],"acceptance":"x"}' }));
    assert.equal(runReview(t).status, 2);
    assert.equal(readdirSync(t.state).some((f) => /^round-\d+\.json$/.test(f)), false);
    assert.doesNotMatch(readFileSync(t.log, "utf8"), /pr comment/);
  });

  it("cleans its scratch folder even on failure", () => {
    const count = () => readdirSync(tmpdir()).filter((f) => f.startsWith("nstack-review-") && !f.startsWith("nstack-review-test-")).length;
    const before = count();
    const t = setup("not json");
    assert.equal(runReview(t).status, 2);
    assert.equal(count(), before);
  });

  it("wrong usage exits 1", () => {
    const t = setup("");
    assert.equal(spawnSync(process.execPath, [REVIEW], { cwd: t.repo, env: t.env, encoding: "utf8" }).status, 1);
  });
});
