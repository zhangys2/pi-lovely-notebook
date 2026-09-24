# Lovely notebook

Agent tools for Jupyter notebooks: file-level reading and editing, plus execution through the
editor the user already has open.

## Language

**Disk notebook**:
The `.ipynb` file as saved on disk; everything the file-level notebook tools read and write.
_Avoid_: file, saved copy

**Live document**:
VSCode's in-memory copy of an open notebook, possibly with unsaved edits; what the bridge executes.
_Avoid_: open notebook, buffer, editor copy

**Bridge**:
The companion VSCode extension that lets Pi execute cells of a **Live document** in the kernel
VSCode has selected.
_Avoid_: server, VSCode API

**Bridge window**:
One VSCode window running the **Bridge**, discoverable by Pi through its per-user connection file.
_Avoid_: instance, session

**Source match**:
The precondition for executing a cell: the **Live document** cell's source equals the same
cell's source in the **Disk notebook** at the time of the run. A mismatch fails the run instead
of executing code the agent has not seen.
_Avoid_: sync check, dirty check
