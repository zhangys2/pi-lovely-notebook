# Plan

Done: file-oriented notebook tools (summary, search, read, edit, structural mutation, outputs,
attachments) over a shared core, shipped as a Pi extension and a stdio MCP server. Interim
execution: `notebook_run_all` runs a whole notebook in a fresh kernel through nbconvert.

Next: execute single cells in the kernel the user already selected in VSCode, through a companion
VSCode extension (the **Bridge**, see `CONTEXT.md`). Design settled in ADR-0010 (live document
behind a source match) and ADR-0011 (localhost HTTP, per-user discovery).

Why: VSCode/Jupyter owns the live document, kernel selection, dirty state, output UI and
interactive execution semantics. Bridging to that is cheap; reimplementing it is not.
Execution is Pi-only; the MCP server stays file-only.

## Ground rules

- Keep the seams: `packages/core/src/notebook.ts` stays pure notebook JSON (no kernel code),
  `packages/core/src/tools.ts` stays the runner/test seam,
  `packages/pi/extensions/notebook/index.ts` stays the Pi adapter seam.
- Bridge is another `packages/*` with a narrow purpose-built RPC surface, not generic VSCode APIs.
- Execution goes through the same path normalization and per-file queue as mutation.
- Fail honestly ("open it in VSCode and select a kernel") rather than pretend Pi has kernel state.

## [ ] Protocol

Localhost HTTP, bearer token, Host-header check. Connection file per window:
`~/.pi/agent/vscode-bridge/<pid>.json` = `{ port, token, workspaceFolders }`; Pi drops files with
dead pids. Request/response types live in the bridge package; Pi imports them type-only.

Methods, all keyed by absolute notebook path:
- `health`
- `hasNotebook(path)`: open in this window, and whether a kernel is selected.
- `executeCell({ path, cellId?|index?, expectedSource, timeoutSeconds })` → outputs of that cell,
  whether it saved, or a typed failure: not open, no kernel, cell not found, source mismatch,
  timed out (kernel interrupted).

## [ ] Pi-side tool

`notebook_execute_cell({ path, cellId?|index?, timeoutSeconds? })` (default 600s). Reads the disk
cell to build `expectedSource`, finds the bridge window, calls `executeCell`, and returns the
outputs in the same shape as `notebook_read_cell_output`. Esc aborts, and the bridge interrupts
the kernel. After a bridge save, re-read through core so the stale guard re-arms. Guidelines state
the VSCode requirement and the source-match failure.

## [ ] Bridge package

Activates on `onNotebook:jupyter-notebook`. HTTP server, token, connection file written on
activate and removed on deactivate. Handlers depend on a `NotebookHost` interface, not `vscode`
globals, so they are testable with a fake. Cells are resolved by `metadata.id` or index. Save
after the run only if the document had no unsaved edits before it. `bun run package` builds a
local VSIX.

## [ ] Tests

Handler tests with a fake `NotebookHost` (source mismatch, unsaved document not saved, timeout
interrupts). Pi client tests against a mock bridge and temp connection files (missing, dead pid,
bad token, not open, success). One activation smoke test via `@vscode/test-electron`. Real
VSCode+Jupyter execution stays a documented manual smoke test until the semantics stabilize.

## [ ] Docs

Update `CODE.md` once bridge files exist. Document VSIX install/dev flow and execution limits.

## Not doing

Persistent Jupyter kernels inside Pi. A generic VSCode API bridge. Replacing the disk-based
notebook tools. Live-kernel run-all (use `notebook_run_all`). Opening notebooks or kernel pickers
from the bridge. Marketplace publishing before the protocol settles.
