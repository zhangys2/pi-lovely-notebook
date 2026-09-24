import type { ExecuteCellFailure, ExecuteCellRequest, ExecuteCellResponse } from "./protocol"

export interface HostCell {
	/** nbformat cell id, as VSCode's ipynb serializer keeps it in `metadata.id`; absent until first save. */
	id?: string
	source: string
}

export type RunResult = "done" | "timeout" | "aborted"

/** One live document, as the handlers see it. The real one wraps `vscode.NotebookDocument`. */
export interface HostDocument {
	readonly isDirty: boolean
	cells(): HostCell[]
	/** Only a started kernel counts: Jupyter's API cannot see a selected-but-idle one. */
	hasRunningKernel(): Promise<boolean>
	/** Runs one cell to completion; on timeout or abort, interrupts it first. */
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
	if (!(await document.hasRunningKernel())) {
		return fail("no-kernel", `No running kernel for ${request.path} in VSCode. Select a kernel and run any cell once, then retry.`)
	}

	const wasDirty = document.isDirty
	const result = await document.execute(index, request.timeoutSeconds * 1000, signal)
	if (result !== "done") {
		return fail("timeout", `The cell did not finish within ${request.timeoutSeconds}s (or was cancelled); the kernel was interrupted.`)
	}
	const outputs = document.outputs(index)
	if (!wasDirty) await document.save()
	return { ok: true, index, outputs, saved: !wasDirty }
}
