import { homedir } from "node:os"
import { join } from "node:path"
import type { Jupyter } from "@vscode/jupyter-extension"
import * as vscode from "vscode"
import { BRIDGE_DIRECTORY } from "./protocol"
import { startBridgeServer } from "./server"
import { vscodeNotebookHost } from "./vscode-host"

export async function activate(context: vscode.ExtensionContext) {
	const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter")
	if (!jupyterExtension) throw new Error("Lovely Notebook Bridge needs the Jupyter extension (ms-toolsai.jupyter).")
	const jupyter = await jupyterExtension.activate()
	const server = await startBridgeServer(vscodeNotebookHost(jupyter), join(homedir(), ...BRIDGE_DIRECTORY))
	context.subscriptions.push({ dispose: () => void server.close() })
}

export function deactivate() {}
