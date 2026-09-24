# Lovely Notebook Bridge

Lets the [pi lovely-notebook extension](../pi/README.md) run a notebook cell in the kernel VSCode
already has running, via its `notebook_execute_cell` tool.

## Install

```bash
cd packages/vscode
bun run package
code --install-extension dist/lovely-notebook-bridge.vsix
```

Requires the Jupyter extension (`ms-toolsai.jupyter`). On first use Jupyter may ask whether this
extension may access kernels; allow it.

## How it behaves

- Starts when a notebook opens. Listens on `127.0.0.1` only, with a random token, and publishes
  its port and token in `~/.pi/agent/vscode-bridge/<pid>.json` for pi to find.
- Runs a cell only if its source in VSCode matches the notebook on disk. Otherwise pi is told to
  ask you to save or revert first.
- Needs a running kernel: select one and run any cell once. It never opens the kernel picker.
- Saves the notebook after the run only if it had no unsaved edits, so your own unsaved work is
  never saved for you.
- A run past its timeout, or cancelled from pi, interrupts the cell.
