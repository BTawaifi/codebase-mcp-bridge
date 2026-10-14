# MCP Tool Selection Notes

The bridge exposes capabilities, not a prescribed coding workflow. Choose the smallest tool that provides the fact or action needed now.

## Repository targeting

Operational tools default to the repository the server was started in. Pass `workspaceId` only when targeting another trusted workspace.

- `workspace.list`: discover operator-trusted workspace ids.
- `workspace.status`: inspect repository identity/path/type.

Trust expansion is intentionally outside MCP.

## Search and inspection

- `code.search`: literal or regex repository text search. Batch related searches in one call.
- `code.read`: exact file/range reads. Batch related ranges in one call.
- `code.symbols`: lexical symbol-definition lookup when names/structure are more useful than text grep.
- `code.references`: low-confidence lexical caller/callee/impact estimate. Treat results as hints, not resolved language-server facts.

Avoid broad reads when targeted ranges are enough. Avoid symbol/reference calls when ordinary text search already identifies the relevant code.

## Mutations

- `code.patch`: contextual unified-diff edit with stale protection and rollback snapshot.
- `code.write`: deliberate whole-file creation/replacement.
- `code.delete`: one-file deletion with rollback snapshot.
- `code.rollback`: restore a prior snapshot; the rollback itself creates an inverse snapshot.

Do not use `command.run` merely because shell syntax can perform the same edit.

## Git

- `git.status`: branch and staged/unstaged/mixed/untracked paths.
- `git.diff`: exact Git diff facts; use path scoping for large worktrees.
- `git.commit`: commit the current index, or pass `paths` to stage/commit only those paths.
- `git.push`: remote-impact operation.

An explicit invalid diff base is an error. The bridge does not silently pick a replacement base.

## Validation

`validation.run` accepts several configured command ids in one call. It defaults to compact failure-focused output. Use `stopOnFailure` when later checks are pointless after an earlier failure.

## Shell escape hatch

`command.run` is disabled unless the server operator sets `BRIDGE_ENABLE_COMMAND_RUN=true`. Prefer structured code, Git, and validation capabilities whenever they express the task.

## Performance properties

- Search batches use bounded concurrency rather than serial execution or unbounded process fanout.
- Read batches use bounded filesystem concurrency.
- Per-workspace service objects are reused.
- Symbol-index refresh work is coalesced and briefly cached; bridge mutations explicitly invalidate freshness.
- Search results omit backend/profiling telemetry from the public response.
- Validation output is bounded and does not write hidden test-output artifacts.
- Audit logging stores metadata only, not full tool arguments or source patches.

## Security boundaries

- Repository path traversal is rejected.
- Search/read paths filter secret-bearing content.
- Git mutation policy blocks `.env`, private-key material, and Git internals without blocking ordinary generated/lock files just because they are noisy for model reading.
- HTTP OAuth authorization and high-risk HTTP gating are separate controls.
- The model cannot enlarge its own trusted-workspace set.
