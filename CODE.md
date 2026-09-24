# Pi notebook monorepo

Tools for safe `.ipynb` inspection and editing, exposed as a Pi extension and as a
local stdio MCP server over one shared core.

## Layout

Bun workspace (`workspaces: ["packages/*"]`), three independently published `@xl0` packages:

- `packages/core` — `@xl0/lovely-notebook`: notebook JSON logic + adapter-neutral tool layer.
  No Pi/MCP imports; only runtime dep is `typebox` (peer).
- `packages/pi` — `@xl0/pi-lovely-notebook`: Pi extension adapter; core + Pi peers.
- `packages/mcp` — `@xl0/lovely-notebook-mcp`: stdio MCP server; core + MCP SDK + typebox.
- `packages/vscode` — `lovely-notebook-bridge`: private VSCode extension (local VSIX) that runs
  cells for Pi's `notebook_execute_cell`. No core dependency.

Thin adapters keep the Pi and MCP dependency trees isolated. Root `package.json` sets
`pi.extensions: ["./packages/pi/extensions"]` so Pi sessions in this repo dogfood the extension.

Root `README.md` is the project entry point; each package carries its own npm-facing
`README.md` + `LICENSE` (MIT) and full npm metadata, plus `bun run release` to publish it.

Publishing is built, because node refuses to strip types under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — shipping source alone made `npx` installs
bun-only, which is the wrong bet for an MCP server. `bun run release` builds first:

- core: `bun build --target node` ESM + `tsgo -p tsconfig.build.json` declarations. Its `exports`
  keeps a `bun` condition pointing at `src/`, so bun (and everything in this repo) still runs the
  TypeScript directly and no build is needed for development. Root tsconfig sets
  `customConditions: ["bun"]` so typecheck resolves `src/` too, not the unbuilt `dist/*.d.ts`.
- mcp: one `dist/bin.js` bundle from `src/bin.ts`, SDK/typebox/core external. `bin.ts` exists so
  the published entry connects the transport without an `import.meta.main` guard — bun compiles
  that to `__require.main`, which throws under node.
- pi: source only. Pi's npm (Node) build loads extensions through jiti, which compiles TypeScript
  but resolves packages like Node, so core's `bun` condition never applies there. The Pi adapter
  therefore imports core as `@xl0/lovely-notebook/source` (an export straight to `src/index.ts`,
  shipped in the core package), which jiti compiles in the repo and inside a real
  `node_modules` alike. Importing the bare specifier made Pi require a built `dist/`.

## Core

`packages/core/src/notebook.ts` — pure notebook JSON operations, no I/O beyond load/save.

- nbformat 4 only; cell types `code`, `markdown`, `raw`.
- On parse everything is normalized to typed internal shapes: source and stream `text` to one
  `string`, metadata to a typed object, attachments to typed MIME bundles, outputs to a typed
  union (unknown output fields preserved).
- Save reproduces Jupyter's canonical form byte for byte: keys sorted at every level, 1-space
  indent, `source` and stream `text` back to `string[]`, trailing newline. Same rules as
  nbformat's `JSONWriter` (`sort_keys=True`) and VSCode's `sortObjectPropertiesRecursively`.
  Without this a one-cell edit rewrote ~770 lines of a 13k-line notebook and buried its own diff.
  Mime-bundle and attachment values are never re-split, since parsing leaves them untouched;
  nbformat would split `text/*`, `application/javascript` and `image/svg+xml`.
- The input file's indent and line ending are detected on parse and reused on save (Jupyter
  writes 1 space, Colab 2; Windows autocrlf checkouts are CRLF), kept in a `WeakMap` keyed by the
  notebook so they never reach the file. VSCode does the same for indent via `detectIndent` plus
  in-memory `indentAmount` metadata.
- Helpers take 0-based indexes only; selector resolution lives in the tool layer.
- Id policy: no-id notebooks stay no-id, missing ids are never backfilled, inserted cells
  get ids only when the notebook already uses ids or `nbformat_minor >= 5`.
- Summary format: one `meta` line, then a pseudo-XML `<cell>` element per cell (with `atts=`,
  `n_exec` when present, `id` only when stored) containing its source preview and one `<output>`
  element per output MIME variant. Elements self-close only when genuinely empty (image-only
  output variants), so preview text that looks like markup — Python reprs such as
  `<module.Class>` are the common case — cannot be read as structure. Containment is why output
  elements carry no `cell_id`.
- `notebook_read_cell_output` on a rich output with no `mime` uses the same element shape, one
  `<output mime=...>` per variant; image and empty variants self-close, which also tells the
  model an image existed under `includeImages: false`.
- `image/svg+xml` is an image whose payload is text: it self-closes like any image instead of
  dumping thousands of markup lines into a default read, and is returned as text (paginated)
  only when requested by mime. As attachment content it goes out as text either way — sent as
  image content it would just fail the host's resizer with a misleading size note — decoding
  base64 when it is stored that way, which is what JupyterLab does with pasted images.
- `outputIndex` is optional: omitted means the cell's only output, and more than one output is an
  error naming the count, never a silent pick. 94% of output-bearing cells in the fixtures and
  the lovely-tensors/lovely-numpy notebooks have exactly one output.
- Two conventions, deliberately distinct: pseudo-XML elements for structure, `[...]` notes for
  inline or appended annotations (`[image: mime/type]`, `[N more lines]`, `[Image omitted: ...]`)
  that never claim to contain anything.
- Previews (source and output alike) are bounded three ways: 5 lines with a `[N more lines]`
  marker, 500 chars per line, and `data:` image URIs replaced by `[image: mime/type]` — one
  embedded image is a single line, so the line cap alone does not bound it. `sourceLines` still
  counts raw source, so `lines=` stays consistent with read pagination.
- `sliceCellSource` is the single gate every returned text passes through — cell source, output
  text, SVG attachment markup, formatted summary. Reads are capped at 2000 lines *or* 50KB
  (pi's Read tool bounds), even when the caller passes a larger `lineLimit`: one base64 or
  minified line is megabytes, so a line count alone bounds nothing. Truncation always ends in
  the offset to continue from; a single over-budget line is cut mid-line (on a code point
  boundary) and says so, since no offset can resume inside a line.
- Line offsets are 1-based, like every file read tool a model already knows (pi, Claude Code,
  lovely-ide); cell and output indexes stay 0-based as in nbformat. Both are spelled out in the
  schemas and in the shared guidelines, and truncation notes quote the exact offset to pass back.
  Pi's `path:start-end` read header assumed 1-based line numbers all along.
- An empty slice (empty source, offset at the end, `lineLimit: 0`) returns `[Empty]` or
  `[No lines at offset N: ...]`. Tool content with no text at all reads as a failure.
- ANSI escape codes are stripped from stream and error text on read (summary and output reads);
  the file keeps them, since Jupyter renders them.
- `searchNotebook` returns one `<cell>` element per matching cell with `line: text` entries,
  1-based so they feed straight into a read's `lineOffset`. With `outputs`, text outputs are
  searched too, nested as `<output index mime?>` elements; they count the same text
  `readCellOutput` returns (ANSI stripped, rich outputs per text-like mime).

`packages/core/src/tools.ts` — runners + typebox schemas; `src/index.ts` re-exports both.

- Each tool exports one `{ name, description, params, run }` descriptor; adapters and tests
  use that single symbol.
- Schemas are colocated with their runner and never shared. String enums go through a local
  `StringEnum` helper so providers see `type: "string"` + `enum` rather than `anyOf`/`const`.
- `mutateNotebook(path, mutate)` consolidates load → mutate → save.
- Stale guard: a per-process map of each path's stamp (mtime + size) as last read or written.
  A mutation refuses a file whose stamp moved since (user saved from an editor, another tool
  wrote it); any read re-arms. Unseen paths are unguarded, and an editor's unsaved buffer is
  invisible — only the planned VSCode bridge can see that.
- Source-changing runners take an optional second arg `onChange({before, after})`, called with
  the touched cell's source only after the save succeeds (insert: empty before; delete: empty
  after; merge: the anchor). MCP ignores it.
- `applyExactSourceEdits` follows pi's edit tool: unique matches, no empty `oldText`, no overlaps,
  must change something. No whitespace-fuzzy fallback (pi has one; we stay exact).
- Runners return `NotebookToolContent` (`{type:"text"}` / `{type:"image", data, mimeType}`),
  MCP-shaped and structurally Pi-compatible. Images are raw base64; resizing/capping is
  an adapter concern.
- Also exported for adapters: `notebookToolGuidelines`. Paths are used as given; resolving them
  is the adapter's job, since each host defines cwd differently.

Tools: `notebook_summary`, `notebook_search`, `notebook_create`, `notebook_read_cell`, `notebook_write_cell`,
`notebook_change_cell_type`, `notebook_edit_cell`, `notebook_insert`, `notebook_delete`,
`notebook_move`, `notebook_merge`, `notebook_clear_outputs`, `notebook_read_cell_output`,
`notebook_read_cell_attachment`. All but summary and search are single-cell and accept `cellId`
or 0-based `index` (`notebook_insert.index = -1` appends). Deliberate ADR-0005 exception:
`notebook_clear_outputs` with no selector clears every code cell, since whole-notebook cleanup
is one logical operation, not N edits.

`parseToolArguments(schema, args)` is the adapters' argument gate: typebox `Convert` then
`Check`, throwing one line per problem, with enum errors listing the allowed values (typebox's
own message omits them, and wrong enum values are the mistake models make). MCP calls it before
running; Pi calls it from `prepareArguments`, which runs ahead of Pi's own validation.

Notable tool semantics: `notebook_create` writes with `wx` so an existing path fails with EEXIST
in the kernel, never through a check-then-write window — replacing a notebook with an empty one
destroys every cell and output. It writes `language_info.name` (a language
like `python`, not a kernel name like `python3`) while leaving `kernelspec` to the editor; read returns raw source only (metadata is
summary-only); markdown `data:` URI images become `[image: mime/type]` markers plus image
content; type changes clear fields invalid for the target type.

Merge requires an adjacent same-type cell and keeps the anchor's id, metadata and outputs. Both
cells' attachments are unioned, as JupyterLab does, because the merged source keeps every
`attachment:key` reference; a key claimed by both with different payloads is refused rather than
picked. The removed cell's outputs go with it (VSCode's join does the same, JupyterLab drops both
cells' outputs) and the count is reported, since nothing else would show the loss.

## Adapters

`packages/pi/extensions/notebook/index.ts`

- Table-driven registration: one `notebookTools` entry per core tool holding label, prompt
  snippet, render style; names/descriptions come from the core descriptors.
- Shared tool semantics live once as namespaced guidelines on `notebook_summary`.
- A `tool_call` hook blocks built-in `read`/`edit`/`write`/`grep` whose `path` or `glob` ends in
  `.ipynb`, with a reason naming the notebook tools. Guidelines alone didn't stop models reading
  escaped JSON or editing it past every structural check. `bash` is left alone.
- Relative paths resolve against `ctx.cwd`. No `@`-mention stripping (pi's own path tools still
  do it via `stripAtPrefix`; current models don't need it).
- Every tool runs under `withFileMutationQueue(normalizedPath, ...)` — reads too, since Pi
  executes tools in parallel.
- `notebook_run_all` (Pi-only, registered outside the table since it needs the abort signal):
  `jupyter nbconvert --execute --inplace` via `pi.exec`, cwd = notebook dir. Flags matter:
  `--allow-errors` (without it nothing is written on the first error, so cells after an error
  still run), `ExecutePreprocessor.timeout=-1` (default 30s/cell; the whole run is bounded by
  `timeoutSeconds` instead), `record_timing=False` (else per-cell timestamp metadata churns
  diffs). Returns an error-cell status line plus the summary, which re-arms the stale guard.
- Write, edit, insert, delete and merge render a source diff with Pi's standard diff UI, built
  from the core `onChange` callback, so the notebook is loaded once per call. Type change, move
  and clear-outputs leave source untouched and keep their text result.
- `resolveContentImages` runs core images through Pi's `resizeImage`; unresizable ones become
  `[Image omitted: ...]` notes.

`packages/mcp/src/server.ts` (`bun packages/mcp/src/bin.ts`, or the `lovely-notebook-mcp` bin)

- Low-level SDK `Server` with `tools/list`/`tools/call`; typebox schemas pass through verbatim
  as `inputSchema`, args go through `parseToolArguments`; failures return `isError` text.
- One global promise-chain queue: every tool call runs to completion before the next starts.
  Calls are short single-file read-parse-writes, so this costs nothing and preserves call order.
- Relative paths resolve against the server process startup cwd.
- No resizer: images above 4MB base64 become omission notes.

## VSCode bridge (ADR-0010, ADR-0011)

`packages/vscode/src/`: `protocol.ts` (wire types, no `vscode` import; Pi imports it type-only),
`handlers.ts` (`executeCell` over a `NotebookHost`/`HostDocument` interface), `server.ts` (HTTP),
`vscode-host.ts` (the real host), `extension.ts` (activation).

- One endpoint, `POST /execute-cell`. Pi walks the connection files and sends the run to each
  live window until one doesn't answer `not-open`, so there is no discovery method.
- `executeCell` order: find document → find cell (`metadata.id` or index) → source match
  (CRLF-normalized, since VSCode on Windows may type CRLF) → kernel status `idle` or `busy`
  (anything else, e.g. stuck `starting` or `dead`, fails fast) → run → outputs → save only if
  the document was clean before the run.
- Auth: 32-byte token compared in constant time, plus `Host` must equal `127.0.0.1:<port>` against
  DNS rebinding. Pi aborting closes the socket, which aborts the run and interrupts the cell.
- `vscode-host.ts`: runs via `notebook.cell.execute` with `{ranges, document}` and waits for the
  cell's `executionSummary.timing.endTime` in `onDidChangeNotebookDocument`, subscribing before it
  starts. On timeout or abort it fires `notebook.cell.cancelExecution` without awaiting it (the
  command blocks for the whole Win32 interrupt) and waits up to 30s for the cell to end:
  `interrupted` or `still-running`. Kernel status is Jupyter's `kernels.getKernel(uri)?.status`,
  which only sees started kernels. Outputs are mapped back to nbformat (stdout/stderr/error mimes
  to stream/error, images to base64, `outputType` metadata for `execute_result`).
- `extension.ts` returns the server close from `deactivate()`, which VSCode awaits; cleanup hung
  on a subscription was cut off by window reloads, leaving connection files of dead windows.
- Verified by a manual smoke test in VSCode 1.139 + Jupyter 2025.9 on Windows: lookup by id and
  index, stream/HTML/PNG/error outputs, save vs not-saved, source mismatch, no kernel, timeout.
- Pi side: `packages/pi/extensions/notebook/bridge.ts` (`executeInBridge`, dead-pid cleanup) and
  `notebook_execute_cell` in `index.ts`. It reads the disk cell with core `readNotebook` for
  `expectedSource`, formats outputs with core `formatCellOutputs`, and re-reads after a bridge
  save to re-arm the stale guard. Path comparison is case-insensitive on Windows.
- `bun run package` in `packages/vscode` bundles to CJS and builds `dist/lovely-notebook-bridge.vsix`.

## Tests and tooling

- `bun test` at root: 124 tests, green. The real-kernel `notebook_run_all` test skips when
  `jupyter` isn't on PATH, which includes CI.
- Bridge: `packages/vscode/test/` covers handlers against a fake host and the HTTP server's auth;
  `packages/pi/test/execute-cell.test.ts` runs the Pi tool against a real bridge server with a
  fake host (HOME/USERPROFILE pointed at a temp dir). `vscode-host.ts` has no automated test.
- `.gitattributes` forces LF on checkout: biome requires it, and fixtures are byte-exact save oracles.
- `packages/core/test/notebook-core.test.ts` covers parse/validation, pure ops, formatting,
  load/save roundtrips. One `notebook-*.tool.test.ts` per tool, one
  `notebook-*.workflow.test.ts` per multi-step flow.
- `packages/pi/test/` covers the resize/omission seam and source diffs;
  `packages/mcp/test/queue.test.ts` covers realpath/symlink serialization.
- Fixtures in `packages/core/test/fixtures/`, including `subtly-corrupt-images.ipynb`
  (valid-looking PNG base64 with undecodable IDAT) to pin the raw-vs-omitted image split.
- `bun run tool -- <tool-name> '<json-args>'` prints raw tool output without launching Pi.
- `bun run check:notebooks [root]` runs the whole core against every `.ipynb` under a tree
  (default: this repo's parent), on copies: parse, summary, cell/output/attachment reads, then a
  save that must not lose content, churn a canonical file, or reformat unstably. 312 real
  notebooks (nbformat 4.0-4.5, 136MB) pass in ~3s.
- CI (`.github/workflows/ci.yml`): `bun install --frozen-lockfile`, `bun run check`, `bun test`
  on Ubuntu and Windows. `bun.lock` is committed so dev and CI resolve the same versions.
- `bun run check` = `tsgo --noEmit` + `biome check`. Biome 2.5.14, git-aware, 140 cols, tabs,
  LF, semicolons as needed. tsconfig is strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, ...) and uses `bun-types`.

## Dependency handling

- Pi core packages stay in `peerDependencies` at `"*"` per Pi package docs; registry
  `pi-coding-agent`/`pi-tui` `^0.80.10` sit in devDependencies for typechecking.
- `bun run link:pi` overlays `node_modules/@earendil-works/*` with symlinks to
  `../pi-mono/packages/*` using raw `rm`+`ln -s` (npm link cannot parse bun workspace trees).
  Rerun after `bun install`.
- `bunfig.toml` pins `linker = "hoisted"` so that overlay has one target location.
- `typebox` is pinned to exactly `1.1.38` — the version pi bundles. Hoisting then unifies it
  with the linked pi-mono packages; a different root version makes `bun install` attempt nested
  installs inside the read-only link targets.

## Decisions

ADRs in `docs/adr/`; domain terms (disk notebook, live document, bridge, source match) in
`CONTEXT.md`. Core stays pure and adapter-free; publish core once and keep Pi/MCP thin.
Notebook JSON is parsed directly, no nbformat dependency. Tools are one-cell-at-a-time with dual
cellId/index selectors. Outputs are preserved on mutation. No `NotebookSession` abstraction —
`mutateNotebook` covers the only real backend (disk).

Tool-set prompt cost, measured at 14 tools: ~8.4K chars of schema + 0.9K of guidelines, about
2.7K tokens (~3K with Pi snippets). Too small to justify merging tools into multiplexed schemas.

## Gaps

- Verification: tests, direct Pi tool calls on a copied fixture, `bun run tool` smoke runs, a
  stub-`ExtensionAPI` registration check, and a full pass of all 13 tools through Claude Code
  against the MCP server (reads, mutations, images, attachments, error paths, concurrent calls).
  The server is registered with Claude Code at local scope for dogfooding, not in the repo.
- Not published to npm yet; READMEs already document the npm install paths. Publish core first
  so the `^0.1.0` core dep in the Pi/MCP packages resolves.
- Notebooks not already in Jupyter's canonical form are reformatted once on first save.
- No-id notebooks depend on index selectors.
- `notebook_run_all` (nbconvert) writes LF, so a CRLF notebook is rewritten by a run.
- Jupyter interrupts on Windows are slow: ~15s to stop a `time.sleep`, and the next run after an
  interrupt can take 15-25s. The bridge reports it honestly but can't speed it up.
- Bridge with two VSCode windows open is untested.
