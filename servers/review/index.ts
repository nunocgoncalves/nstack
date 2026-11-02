/**
 * MCP server: review.
 *
 * Deterministic mechanics for the `ship` skill: the dedicated ticket worktree
 * (worktree_ensure / worktree_remove), convention-correct PR opening (open_pr,
 * draft by default) and a non-blocking CI snapshot (ci_status). Nothing here
 * waits on CI: long waits run as background Bash (bin/ci-wait.sh).
 */

import { createHost } from "../lib/host.ts";
import { registerReviewTools } from "./tools.ts";

const host = createHost();
registerReviewTools(host);

host.serve({
  name: "review",
  version: "0.1.0",
  instructions:
    "Ticket worktrees, PR opening and a CI snapshot. Mutating ticket work happens in the dedicated ticket worktree from worktree_ensure, never the primary checkout. No tool waits on CI; use bin/ci-wait.sh in background Bash.",
});
