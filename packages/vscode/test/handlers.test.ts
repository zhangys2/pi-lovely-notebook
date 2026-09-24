import { expect, test } from "bun:test"
import { executeCell, type HostCell, type HostDocument, type NotebookHost, type RunResult } from "../src/handlers"

function fakeDocument(cells: HostCell[], options: { dirty?: boolean; kernel?: string | undefined; run?: RunResult } = {}) {
	const calls = { executed: [] as number[], saved: 0 }
	const document: HostDocument = {
		isDirty: options.dirty ?? false,
		cells: () => cells,
		kernelStatus: async () => ("kernel" in options ? options.kernel : "idle"),
		execute: async index => {
			calls.executed.push(index)
			return options.run ?? "done"
		},
		outputs: index => [{ output_type: "stream", name: "stdout", text: `out ${index}\n` }],
		save: async () => {
			calls.saved++
		}
	}
	return { document, calls }
}

const host = (path: string, document: HostDocument): NotebookHost => ({ find: candidate => (candidate === path ? document : undefined) })
const cells: HostCell[] = [
	{ id: "a", source: "x = 1\n" },
	{ id: "b", source: "print(x)\n" }
]
const request = { path: "/nb.ipynb", expectedSource: "print(x)\n", timeoutSeconds: 5 }

test("runs a cell found by id, returns its outputs, and saves a clean document", async () => {
	const { document, calls } = fakeDocument(cells)
	expect(await executeCell(host("/nb.ipynb", document), { ...request, cellId: "b" })).toEqual({
		ok: true,
		index: 1,
		outputs: [{ output_type: "stream", name: "stdout", text: "out 1\n" }],
		saved: true
	})
	expect(calls).toEqual({ executed: [1], saved: 1 })
})

test("never saves a document that had unsaved edits before the run", async () => {
	const { document, calls } = fakeDocument(cells, { dirty: true })
	const response = await executeCell(host("/nb.ipynb", document), { ...request, index: 1 })
	expect(response.ok && response.saved).toBe(false)
	expect(calls).toEqual({ executed: [1], saved: 0 })
})

test("refuses to run when the live cell differs from disk, ignoring line-ending differences", async () => {
	const { document, calls } = fakeDocument([{ id: "a", source: "x = 2\r\n" }])
	const mismatch = await executeCell(host("/nb.ipynb", document), { ...request, cellId: "a", expectedSource: "x = 1\n" })
	expect(mismatch).toMatchObject({ ok: false, error: "source-mismatch" })
	expect(calls.executed).toEqual([])

	const crlf = await executeCell(host("/nb.ipynb", document), { ...request, cellId: "a", expectedSource: "x = 2\n" })
	expect(crlf.ok).toBe(true)
})

test("each precondition fails with its own error and runs nothing", async () => {
	const { document, calls } = fakeDocument(cells, { kernel: undefined })
	const run = (overrides: object, on = host("/nb.ipynb", document)) => executeCell(on, { ...request, ...overrides })
	expect(await run({ cellId: "b", path: "/other.ipynb" })).toMatchObject({ ok: false, error: "not-open" })
	expect(await run({ cellId: "zzz" })).toMatchObject({ ok: false, error: "cell-not-found" })
	expect(await run({ index: 7 })).toMatchObject({ ok: false, error: "cell-not-found" })
	expect(await run({ cellId: "b" })).toMatchObject({ ok: false, error: "no-kernel", message: expect.stringContaining("run any cell once") })
	expect(calls.executed).toEqual([])
})

test("a kernel that is not idle or busy (stuck starting, dead) fails fast and names its status", async () => {
	for (const status of ["starting", "dead"]) {
		const { document, calls } = fakeDocument(cells, { kernel: status })
		expect(await executeCell(host("/nb.ipynb", document), { ...request, cellId: "b" })).toMatchObject({
			ok: false,
			error: "no-kernel",
			message: expect.stringContaining(`is ${status}`)
		})
		expect(calls.executed).toEqual([])
	}
	const busy = fakeDocument(cells, { kernel: "busy" })
	expect((await executeCell(host("/nb.ipynb", busy.document), { ...request, cellId: "b" })).ok).toBe(true)
})

test("a timed-out run says whether the interrupt took effect, and does not save", async () => {
	for (const [run, says] of [
		["interrupted", "it was interrupted"],
		["still-running", "still running"]
	] as const) {
		const { document, calls } = fakeDocument(cells, { run })
		expect(await executeCell(host("/nb.ipynb", document), { ...request, cellId: "b" })).toMatchObject({
			ok: false,
			error: "timeout",
			message: expect.stringContaining(says)
		})
		expect(calls.saved).toBe(0)
	}
})
