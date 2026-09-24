# Execute cells in VSCode's live document, gated by a source match

Pi executes single cells through the VSCode bridge in the kernel the user already selected, never in a kernel of its own. The live document can have unsaved edits or lag behind a change Pi just wrote to disk, so a cell runs only when its live source equals its disk source; otherwise the run fails with "save or revert first". Running the live document as-is would execute code the agent never saw, and refusing any document with unsaved edits would block runs whenever the user is typing elsewhere in the notebook.

## Consequences

- The bridge returns the executed cell's outputs in its response. It saves afterwards only if the document had no unsaved edits before the run, so it never commits the user's own unsaved work.
- Cells are found by `cellId` through VSCode's `metadata.id` (the ipynb serializer preserves nbformat ids), or by index. A cell created in VSCode since the last save has no id until it is saved.
- One cell per call. Whole-notebook runs stay on `notebook_run_all` (fresh kernel).
- No bridge window with the notebook open, or no running kernel: fail with instructions. The bridge never opens notebooks or kernel pickers itself. Jupyter's API only sees started kernels, so the user selects one and runs any cell once.
- Timeouts and Esc interrupt the kernel rather than leaving it busy.
