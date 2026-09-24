# Bridge over localhost HTTP, discovered through per-user connection files

Each VSCode window running the bridge listens on 127.0.0.1 at a random port, requires a random bearer token and checks the Host header, and writes `<pid>.json` (port, token, workspace folders) into a per-user directory under `~/.pi/agent/`. Pi asks each live window whether it has the notebook open. Named pipes and Unix sockets would avoid an open port but need separate Windows and POSIX code with less proven Bun support on Windows. A project-level `.pi/` file would put the token inside the repo, allow only one window per folder, and miss notebooks outside the workspace.

## Consequences

- The bridge activates when a notebook opens (`onNotebook:jupyter-notebook`) and deletes its file on deactivate. Pi ignores and removes files whose pid is dead.
- Shipped as a local VSIX until the protocol settles.
