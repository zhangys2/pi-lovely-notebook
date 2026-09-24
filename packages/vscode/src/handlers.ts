import type { ExecuteCellFailure, ExecuteCellRequest, ExecuteCellResponse } from "./protocol"

export interface HostCell {
	/** nbformat cell id, as VSCode's ipynb serializer keeps it in `metadata.id`; absent until first save. */
	id?: string
	source: string
}

/**
 * `interrupted`: timed out or aborted, and the cell stopped after the interrupt. `still-running`:
 * the interrupt was requested but the cell had not stopped within a grace period (Jupyter
 * interrupts on Windows can take 15s or more).
 */
export type RunResult = "done" | "interrupted" | "still-running"

/** One live document, as the handlers see it. The real one wraps `vscode.NotebookDocument`. */
export interface HostDocument {
	readonly isDirty: boolean
	cells(): HostCell[]
	/**
	 * Jupyter kernel status (`idle`, `busy`, `starting`, `dead`, ...), or undefined when no kernel
	 * has started: Jupyter's API cannot see a selected-but-never-started one.
	 */
	kernelStatus(): Promise<string | undefined>
	/** Runs one cell to completion; on timeout or abort, interrupts it and waits a grace period. */
	execute(index: number, timeoutMs: number, signal?: AbortSignal): Promise<RunResult>
	/** nbformat v4 output objects. */
	outputs(index: number): object[]
	save(): Promise<void>
}

export interface NotebookHost {
	/** The open live document for an absolute path, if this window has it. */
	find(path: string): HostDocument | undefined
}

const fail = (error: ExecuteCellFailure, message: string): ExecuteCellResponse => ({ ok: false, error, message })

export async function executeCell(host: NotebookHost, request: ExecuteCellRequest, signal?: AbortSignal): Promise<ExecuteCellResponse> {
	const document = host.find(request.path)
	if (!document) return fail("not-open", `${request.path} is not open in this VSCode window.`)

	const cells = document.cells()
	const index = request.cellId === undefined ? request.index : cells.findIndex(cell => cell.id === request.cellId)
	const cell = index === undefined ? undefined : cells[index]
	if (index === undefined || cell === undefined) {
		const selector = request.cellId ?? `index ${request.index}`
		return fail("cell-not-found", `Cell ${selector} is not in the VSCode copy of ${request.path}. Save it in VSCode, then retry.`)
	}
	// VSCode on Windows may type CRLF into a cell; the serializer and disk notebook use LF.
	if (cell.source.replaceAll("\r\n", "\n") !== request.expectedSource.replaceAll("\r\n", "\n")) {
		return fail("source-mismatch", "The cell in VSCode differs from the notebook on disk. Save or revert it in VSCode, then retry.")
	}
	const status = await document.kernelStatus()
	if (status === undefined) {
		return fail("no-kernel", `No running kernel for ${request.path} in VSCode. Select a kernel and run any cell once, then retry.`)
	}
	// Busy is fine: the cell queues. Anything else (stuck starting, dead) would only wait out the timeout.
	if (status !== "idle" && status !== "busy") {
		return fail("no-kernel", `The kernel for ${request.path} is ${status}. Wait for it, or restart it in VSCode, then retry.`)
	}

	const wasDirty = document.isDirty
	const result = await document.execute(index, request.timeoutSeconds * 1000, signal)
	const stopped = `The cell did not finish within ${request.timeoutSeconds}s, or the run was cancelled`
	if (result === "interrupted") return fail("timeout", `${stopped}; it was interrupted.`)
	if (result === "still-running") {
		return fail("timeout", `${stopped}. An interrupt was requested but the cell is still running; later runs queue behind it.`)
	}
	const outputs = document.outputs(index)
	if (!wasDirty) await document.save()
	return { ok: true, index, outputs, saved: !wasDirty }
}
