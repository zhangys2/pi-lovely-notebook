// Wire protocol between the pi extension (client) and each bridge window (server). No `vscode`
// imports here: pi imports this file type-only.

/** `~/.pi/agent/vscode-bridge/<pid>.json`, written by each bridge window while it runs. */
export interface BridgeConnection {
	pid: number
	port: number
	token: string
}

export const BRIDGE_DIRECTORY = [".pi", "agent", "vscode-bridge"] as const

/** `POST /execute-cell`, bearer token auth. */
export interface ExecuteCellRequest {
	/** Absolute path of the notebook on disk. */
	path: string
	cellId?: string
	index?: number
	/** The cell's source in the disk notebook; the run happens only if the live cell matches it. */
	expectedSource: string
	timeoutSeconds: number
}

export type ExecuteCellFailure = "not-open" | "cell-not-found" | "source-mismatch" | "no-kernel" | "timeout"

export type ExecuteCellResponse =
	| {
			ok: true
			index: number
			/** nbformat v4 output objects of the executed cell. */
			outputs: object[]
			/** False when the document had unsaved edits before the run, which the bridge never commits. */
			saved: boolean
	  }
	| { ok: false; error: ExecuteCellFailure; message: string }
