import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  detectPrimaryCheckoutSync,
  githubSlugFromRemote,
  normalizeTicketId,
  parseWorktreeList,
  siblingCheckoutPath,
  ticketIdFromBranch,
  worktreeRoot,
} from "./worktrees.ts";

describe("workspace convention", () => {
  test("defaults to ~/Developer/worktrees and honors NSTACK_WORKTREE_ROOT", () => {
    expect(worktreeRoot({})).toBe(join(homedir(), "Developer", "worktrees"));
    expect(worktreeRoot({ NSTACK_WORKTREE_ROOT: "/tmp/wt" })).toBe("/tmp/wt");
    expect(worktreeRoot({ NSTACK_WORKTREE_ROOT: "~/wt" })).toBe(join(homedir(), "wt"));
    expect(worktreeRoot({ NSTACK_WORKTREE_ROOT: "  " })).toBe(join(homedir(), "Developer", "worktrees"));
  });

  test("normalizes ticket identifiers", () => {
    expect(normalizeTicketId(" abc-559 ")).toBe("ABC-559");
  });

  test("extracts the ticket id from a convention branch only", () => {
    expect(ticketIdFromBranch("ABC-559-model-reconcile-loop")).toBe("ABC-559");
    expect(ticketIdFromBranch("abc-12-short")).toBe("ABC-12");
    expect(ticketIdFromBranch("ABC-559")).toBeNull();
    expect(ticketIdFromBranch("feature/ABC-559-thing")).toBeNull();
    expect(ticketIdFromBranch("master")).toBeNull();
    expect(ticketIdFromBranch("")).toBeNull();
  });
});

describe("worktree list parsing", () => {
  test("parses primary, linked, and detached worktrees", () => {
    const output = [
      "worktree /repo/mono",
      "HEAD 8352c41e4eb89f4319f8c0972ce9b60a49519b37",
      "branch refs/heads/ABC-559-model-reconcile-loop",
      "",
      "worktree /worktrees/mono/ABC-539",
      "HEAD 840e62766861290987239af685d8424c57dc5edc",
      "branch refs/heads/ABC-539-detach-draft",
      "",
      "worktree /worktrees/mono/ABC-540-release",
      "HEAD 6ec2e5e0000000000000000000000000000000000",
      "detached",
      "",
    ].join("\n");
    const entries = parseWorktreeList(output);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      path: "/repo/mono",
      branch: "ABC-559-model-reconcile-loop",
      head: "8352c41e4eb89f4319f8c0972ce9b60a49519b37",
      detached: false,
    });
    expect(entries[2].branch).toBeNull();
    expect(entries[2].detached).toBe(true);
  });
});

describe("primary checkout detection", () => {
  test("a .git directory marks the primary checkout, a .git file a linked worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
    try {
      const primary = join(root, "mono");
      mkdirSync(join(primary, ".git"), { recursive: true });
      mkdirSync(join(primary, "sub", "dir"), { recursive: true });
      expect(detectPrimaryCheckoutSync(primary)).toBe(true);
      expect(detectPrimaryCheckoutSync(join(primary, "sub", "dir"))).toBe(true);

      const linked = join(root, "worktrees", "mono", "ABC-559");
      mkdirSync(linked, { recursive: true });
      writeFileSync(join(linked, ".git"), "gitdir: /repo/mono/.git/worktrees/ABC-559\n");
      expect(detectPrimaryCheckoutSync(linked)).toBe(false);

      expect(detectPrimaryCheckoutSync(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PR repository checkouts", () => {
  test("reads owner/name from GitHub remotes only", () => {
    expect(githubSlugFromRemote("https://github.com/acme/acme-overlay.git")).toBe(
      "acme/acme-overlay",
    );
    expect(githubSlugFromRemote("git@github.com:acme/acme-mono.git")).toBe("acme/acme-mono");
    expect(githubSlugFromRemote("ssh://git@github.com/o/r")).toBe("o/r");
    expect(githubSlugFromRemote("https://token@github.com/o/r.js/")).toBe("o/r.js");
    expect(githubSlugFromRemote("https://gitlab.com/o/r.git")).toBeNull();
    expect(githubSlugFromRemote("/tmp/origin.git")).toBeNull();
  });

  test("the conventional checkout of another repository is a sibling of the session's", () => {
    expect(siblingCheckoutPath("/src/acme-mono", "acme/acme-overlay")).toBe(
      "/src/acme-overlay",
    );
    expect(() => siblingCheckoutPath("/src/acme-mono", "acme/..")).toThrow(/Invalid GitHub repository/);
    expect(() => siblingCheckoutPath("/src/acme-mono", "no-slash")).toThrow(/Invalid GitHub repository/);
  });
});
