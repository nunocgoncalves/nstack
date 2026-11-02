import { describe, expect, test } from "bun:test";
import type { Host } from "../lib/host.ts";
import { parsePrRef, prMeta, prRepoArgs, prRepoSlug } from "./github.ts";

interface Call {
  cmd: string;
  args: string[];
}

/** Records every `gh` invocation; answers each with the first matching reply. */
function recordingHost(replies: Array<{ match: (args: string[]) => boolean; code?: number; stdout?: string; stderr?: string }>) {
  const calls: Call[] = [];
  const host = {
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const reply = replies.find((r) => r.match(args));
      return { code: reply?.code ?? 0, stdout: reply?.stdout ?? "", stderr: reply?.stderr ?? "" };
    },
  } as unknown as Host;
  return { host, calls };
}

const opts = { cwd: "/session/acme-mono" };
const OVERLAY_URL = "https://github.com/acme/acme-overlay/pull/107";

describe("parsePrRef", () => {
  test("reads the repository and number from a PR URL", () => {
    expect(parsePrRef(OVERLAY_URL)).toEqual({ repo: "acme/acme-overlay", number: "107" });
    expect(parsePrRef(`${OVERLAY_URL}/files`)).toEqual({ repo: "acme/acme-overlay", number: "107" });
    expect(parsePrRef(`${OVERLAY_URL}?w=1`).number).toBe("107");
    expect(parsePrRef(`${OVERLAY_URL}#discussion_r1`).number).toBe("107");
    expect(parsePrRef(` http://www.github.com/o/r.js/pull/7 `)).toEqual({ repo: "o/r.js", number: "7" });
  });

  test("reads owner/repo#N", () => {
    expect(parsePrRef("acme/acme-overlay#107")).toEqual({
      repo: "acme/acme-overlay",
      number: "107",
    });
  });

  test("keeps a bare number on the session's repository", () => {
    expect(parsePrRef("107")).toEqual({ number: "107" });
    expect(parsePrRef(107)).toEqual({ number: "107" });
    expect(parsePrRef("#107")).toEqual({ number: "107" });
    expect(prRepoArgs(parsePrRef("107"))).toEqual([]);
  });

  test("fails closed on references whose repository cannot be resolved", () => {
    expect(() => parsePrRef("https://github.example.com/o/r/pull/1")).toThrow(/Could not resolve/);
    expect(() => parsePrRef("https://github.com/o/r/issues/1")).toThrow(/Could not resolve/);
    expect(() => parsePrRef("https://github.com/o/pull/1")).toThrow(/Could not resolve/);
    expect(() => parsePrRef("ABC-646-branch")).toThrow(/Could not resolve/);
    expect(() => parsePrRef("")).toThrow(/Could not resolve/);
  });
});

describe("gh arguments follow the PR's repository", () => {
  test("pr view carries -R for a named repository", async () => {
    const { host, calls } = recordingHost([{ match: (a) => a[1] === "view", stdout: "{}" }]);
    await prMeta(host, opts, OVERLAY_URL);
    expect(calls.map((c) => c.args.slice(0, 5))).toEqual([["pr", "view", "107", "-R", "acme/acme-overlay"]]);
    expect(calls.every((c) => c.cmd === "gh")).toBe(true);
  });

  test("a bare number never passes -R and resolves the slug from the working directory", async () => {
    const { host, calls } = recordingHost([
      { match: (a) => a[0] === "repo", stdout: JSON.stringify({ nameWithOwner: "acme/acme-mono" }) },
      { match: (a) => a[1] === "view", stdout: "{}" },
    ]);
    await prMeta(host, opts, "107");
    expect(calls[0].args).not.toContain("-R");
    expect(await prRepoSlug(host, opts, "107")).toBe("acme/acme-mono");
    expect(await prRepoSlug(host, opts, OVERLAY_URL)).toBe("acme/acme-overlay");
    // Only the bare number consulted the working directory's repository.
    expect(calls.filter((c) => c.args[0] === "repo")).toHaveLength(1);
  });
});
