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

## [x] Bridge built

- Protocol: one endpoint `POST /execute-cell`; Pi tries each live window, no discovery method.
- Pi tool `notebook_execute_cell`, bridge package with fake-host tests, local VSIX, docs.

## [x] Manual smoke test in real VSCode + Jupyter

Passed on Windows; it found and fixed stuck-kernel detection, premature "interrupted", and
connection files left by reloads.

## [ ] Leftover smoke checks

Two VSCode windows. Esc from a live pi session (the smoke used a driver script, `timeoutSeconds`
only). Re-run the timeout check once after the non-awaited cancel fix.

## [ ] Activation smoke test

One `@vscode/test-electron` test that activates the extension and sees the connection file. Only
if the manual smoke test shows activation is fragile; it downloads VSCode in CI.

## Not doing

Persistent Jupyter kernels inside Pi. A generic VSCode API bridge. Replacing the disk-based
notebook tools. Live-kernel run-all (use `notebook_run_all`). Opening notebooks or kernel pickers
from the bridge. Marketplace publishing before the protocol settles.
