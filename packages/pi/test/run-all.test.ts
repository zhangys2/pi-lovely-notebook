import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { notebookCreateTool, notebookEditCellTool, notebookInsertTool, notebookReadCellTool } from "@xl0/lovely-notebook"
import notebookExtension from "../extensions/notebook"

type ExecResult = { code: number; stdout: string; stderr: string; killed: boolean }
type RunAllTool = {
	name: string
	execute: (
		id: string,
		params: object,
		signal: undefined,
		onUpdate: undefined,
		ctx: { cwd: string }
	) => Promise<{ content: Array<{ text?: string }> }>
}

function runAllTool(exec: (command: string, args: string[], options: { cwd: string }) => Promise<ExecResult>): RunAllTool {
	const tools: RunAllTool[] = []
	notebookExtension({ on: () => {}, exec, registerTool: (tool: RunAllTool) => tools.push(tool) } as unknown as ExtensionAPI)
	const tool = tools.find(candidate => candidate.name === "notebook_run_all")
	if (!tool) throw new Error("notebook_run_all not registered")
	return tool
}

async function tempNotebook(sources: string[]) {
	const dir = await mkdtemp(join(tmpdir(), "notebook-run-all-"))
	const path = join(dir, "run.ipynb")
	await notebookCreateTool.run({ path })
	for (const source of sources) await notebookInsertTool.run({ path, index: -1, direction: "after", type: "code", source })
	return { dir, path }
}

test("a failed jupyter run says so and suggests the install check", async () => {
	const notebook = await tempNotebook(["1"])
	try {
		const tool = runAllTool(async () => ({ code: 1, stdout: "", stderr: "", killed: false }))
		await expect(tool.execute("call", { path: notebook.path }, undefined, undefined, { cwd: notebook.dir })).rejects.toThrow(
			"Is Jupyter installed and on PATH?"
		)
	} finally {
		await rm(notebook.dir, { recursive: true, force: true })
	}
})

test.skipIf(!Bun.which("jupyter"))(
	"runs a notebook in a real kernel, reports errors, and leaves it editable",
	async () => {
		const notebook = await tempNotebook(["x = 41", "print(x + 1)", "1/0", 'print("after")'])
		const exec = async (command: string, args: string[], options: { cwd: string }): Promise<ExecResult> => {
			const proc = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" })
			const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
			return { code, stdout, stderr, killed: false }
		}
		try {
			const result = await runAllTool(exec).execute("call", { path: notebook.path }, undefined, undefined, { cwd: notebook.dir })
			const [status = "", summary = ""] = result.content.map(item => item.text ?? "")
			expect(status).toMatch(/errors in cell\(s\) [0-9a-f]+\. Cells after the first error still ran\./)
			expect(summary).toContain("42")
			expect(summary).toContain('ename="ZeroDivisionError"')
			expect(summary).toContain("after")
			expect(await Bun.file(notebook.path).text()).not.toContain("iopub.execute_input")
			// The rewrite by nbconvert was read back, so the stale guard lets the next edit through.
			const cellId = /<cell index="0" id="([0-9a-f]+)"/.exec(summary)?.[1] ?? ""
			await notebookEditCellTool.run({ path: notebook.path, cellId, edits: [{ oldText: "41", newText: "1" }] })
			expect((await notebookReadCellTool.run({ path: notebook.path, cellId }))[0]).toEqual({ type: "text", text: "x = 1" })
		} finally {
			await rm(notebook.dir, { recursive: true, force: true })
		}
	},
	120_000
)
