import { resolve } from "node:path"
import type { Jupyter } from "@vscode/jupyter-extension"
import * as vscode from "vscode"
import type { HostDocument, NotebookHost, RunResult } from "./handlers"

// Windows paths differ in drive-letter case and separators between pi and VSCode's fsPath.
const samePath = (a: string, b: string) =>
	process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

const decoder = new TextDecoder()

/** VSCode output items back to an nbformat v4 output, the inverse of the ipynb serializer's mapping. */
function toNbformat(output: vscode.NotebookCellOutput): object {
	const items = output.items
	const stream = items.find(item => item.mime.startsWith("application/vnd.code.notebook.std"))
	if (stream) {
		const name = stream.mime.endsWith("stderr") ? "stderr" : "stdout"
		return { output_type: "stream", name, text: items.map(item => decoder.decode(item.data)).join("") }
	}
	const error = items.find(item => item.mime === "application/vnd.code.notebook.error")
	if (error) {
		const { name, message, stack } = JSON.parse(decoder.decode(error.data)) as { name: string; message: string; stack?: string }
		return { output_type: "error", ename: name, evalue: message, traceback: [stack ?? `${name}: ${message}`] }
	}
	const data = Object.fromEntries(
		items.map(item => {
			if (item.mime.startsWith("image/") && item.mime !== "image/svg+xml") return [item.mime, Buffer.from(item.data).toString("base64")]
			const text = decoder.decode(item.data)
			return [item.mime, item.mime.endsWith("json") ? JSON.parse(text) : text]
		})
	)
	const executeResult = output.metadata?.["outputType"] === "execute_result"
	return {
		output_type: executeResult ? "execute_result" : "display_data",
		data,
		metadata: {},
		...(executeResult && { execution_count: null })
	}
}

// Measured: Jupyter's Win32 interrupt took ~15s to stop a time.sleep in the smoke test.
const INTERRUPT_GRACE_MS = 30_000

/** Resolves true when `ended` settles first, false on the timer or abort. */
function within(ended: Promise<void>, ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise(settle => {
		const timer = setTimeout(() => settle(false), ms)
		signal?.addEventListener("abort", () => settle(false), { once: true })
		void ended.then(() => {
			clearTimeout(timer)
			settle(true)
		})
	})
}

async function runCell(document: vscode.NotebookDocument, index: number, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
	const cell = document.cellAt(index)
	const target = { ranges: [{ start: index, end: index + 1 }], document: document.uri }
	let subscription: vscode.Disposable | undefined
	// Subscribe before starting, so a fast cell cannot finish unobserved. A new end time only
	// appears once this run completes; the previous summary never fires a change.
	const ended = new Promise<void>(resolve => {
		subscription = vscode.workspace.onDidChangeNotebookDocument(event => {
			if (event.notebook !== document) return
			if (event.cellChanges.some(change => change.cell === cell && change.executionSummary?.timing?.endTime !== undefined)) resolve()
		})
	})
	try {
		void vscode.commands.executeCommand("notebook.cell.execute", target)
		if (await within(ended, timeoutMs, signal)) return "done"
		// Not awaited: the command itself can block for the whole slow Win32 interrupt.
		void vscode.commands.executeCommand("notebook.cell.cancelExecution", target)
		return (await within(ended, INTERRUPT_GRACE_MS)) ? "interrupted" : "still-running"
	} finally {
		subscription?.dispose()
	}
}

export function vscodeNotebookHost(jupyter: Jupyter): NotebookHost {
	return {
		find(path) {
			const document = vscode.workspace.notebookDocuments.find(
				candidate => candidate.notebookType === "jupyter-notebook" && samePath(candidate.uri.fsPath, path)
			)
			if (!document) return undefined
			const host: HostDocument = {
				get isDirty() {
					return document.isDirty
				},
				cells: () =>
					document.getCells().map(cell => {
						const id = cell.metadata["id"]
						return { source: cell.document.getText(), ...(typeof id === "string" && { id }) }
					}),
				kernelStatus: async () => (await jupyter.kernels.getKernel(document.uri))?.status,
				execute: (index, timeoutMs, signal) => runCell(document, index, timeoutMs, signal),
				outputs: index => document.cellAt(index).outputs.map(toNbformat),
				save: async () => {
					await document.save()
				}
			}
			return host
		}
	}
}
