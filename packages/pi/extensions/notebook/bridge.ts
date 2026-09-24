import { readdir, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
// Type-only: the published pi package must not depend on the VSCode extension package.
import type { BridgeConnection, ExecuteCellRequest, ExecuteCellResponse } from "../../../vscode/src/protocol"

/** Must match `BRIDGE_DIRECTORY` in packages/vscode/src/protocol.ts. */
export const bridgeDirectory = () => join(homedir(), ".pi", "agent", "vscode-bridge")

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: alive but owned by another user, which a VSCode window of this user never is.
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * Asks each bridge window in turn; the first that has the notebook open runs the cell. Files of
 * dead windows (VSCode killed before deactivate) are removed on the way.
 */
export async function executeInBridge(dir: string, request: ExecuteCellRequest, signal?: AbortSignal): Promise<ExecuteCellResponse> {
	const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return []
		throw error
	})
	for (const file of files.filter(name => name.endsWith(".json"))) {
		const connection = JSON.parse(await readFile(join(dir, file), "utf8")) as BridgeConnection
		if (!isAlive(connection.pid)) {
			await rm(join(dir, file), { force: true })
			continue
		}
		const response = await fetch(`http://127.0.0.1:${connection.port}/execute-cell`, {
			method: "POST",
			headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
			body: JSON.stringify(request),
			...(signal && { signal })
		})
		if (!response.ok) throw new Error(`VSCode bridge in process ${connection.pid} answered HTTP ${response.status}.`)
		const result = (await response.json()) as ExecuteCellResponse
		if (result.ok || result.error !== "not-open") return result
	}
	return {
		ok: false,
		error: "not-open",
		message: `${request.path} is not open in any VSCode window running the Lovely Notebook bridge. Open it in VSCode and select a kernel, then retry.`
	}
}
