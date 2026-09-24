import { homedir } from "node:os"
import { join } from "node:path"
import type { Jupyter } from "@vscode/jupyter-extension"
import * as vscode from "vscode"
import { BRIDGE_DIRECTORY } from "./protocol"
import { startBridgeServer } from "./server"
import { vscodeNotebookHost } from "./vscode-host"

let server: Awaited<ReturnType<typeof startBridgeServer>> | undefined

export async function activate() {
	const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter")
	if (!jupyterExtension) throw new Error("Lovely Notebook Bridge needs the Jupyter extension (ms-toolsai.jupyter).")
	const jupyter = await jupyterExtension.activate()
	server = await startBridgeServer(vscodeNotebookHost(jupyter), join(homedir(), ...BRIDGE_DIRECTORY))
}

// Returned, not fire-and-forget from a subscription: VSCode awaits deactivate's promise, while a
// window reload kills the extension host before an unawaited cleanup finishes.
export function deactivate() {
	return server?.close()
}
