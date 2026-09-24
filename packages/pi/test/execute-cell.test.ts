import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { notebookCreateTool, notebookEditCellTool, notebookInsertTool } from "@xl0/lovely-notebook"
import type { HostDocument } from "../../vscode/src/handlers"
import { startBridgeServer } from "../../vscode/src/server"
import notebookExtension from "../extensions/notebook"
import { bridgeDirectory, executeInBridge } from "../extensions/notebook/bridge"

type ExecuteTool = {
	name: string
	execute: (id: string, params: object, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<{ content: unknown[] }>
}

// homedir() reads HOME (POSIX) or USERPROFILE (Windows) on every call, so the bridge directory follows.
const homeVariables = ["HOME", "USERPROFILE"] as const
const savedEnv = homeVariables.map(name => [name, process.env[name]] as const)
let home: string
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "bridge-home-"))
	for (const name of homeVariables) process.env[name] = home
})
afterEach(async () => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
	await rm(home, { recursive: true, force: true })
})

async function notebookWith(source: string) {
	const path = join(home, "nb.ipynb")
	await notebookCreateTool.run({ path })
	await notebookInsertTool.run({ path, index: -1, direction: "after", type: "code", source })
	return path
}

function liveDocument(source: string, options: { dirty?: boolean; onSave?: () => Promise<void> } = {}): HostDocument {
	return {
		isDirty: options.dirty ?? false,
		cells: () => [{ source }],
		hasRunningKernel: async () => true,
		execute: async () => "done",
		outputs: () => [{ output_type: "execute_result", execution_count: 1, data: { "text/plain": "42" }, metadata: {} }],
		save: options.onSave ?? (async () => {})
	}
}

function executeTool(): ExecuteTool {
	const tools: ExecuteTool[] = []
	notebookExtension({ on: () => {}, registerTool: (tool: ExecuteTool) => tools.push(tool) } as unknown as ExtensionAPI)
	const tool = tools.find(candidate => candidate.name === "notebook_execute_cell")
	if (!tool) throw new Error("notebook_execute_cell not registered")
	return tool
}

test("with no bridge running, or only dead windows left behind, the notebook is reported not open", async () => {
	const request = { path: "/nb.ipynb", index: 0, expectedSource: "", timeoutSeconds: 5 }
	expect(await executeInBridge(bridgeDirectory(), request)).toMatchObject({ ok: false, error: "not-open" })

	await rm(bridgeDirectory(), { recursive: true, force: true })
	await Bun.write(join(bridgeDirectory(), "999999.json"), JSON.stringify({ pid: 999999, port: 1, token: "x" }))
	expect(await executeInBridge(bridgeDirectory(), request)).toMatchObject({ ok: false, error: "not-open" })
	expect(await readdir(bridgeDirectory())).toEqual([])
})

test("notebook_execute_cell runs the disk cell in the live document and re-arms the stale guard after the bridge saves", async () => {
	const path = await notebookWith("6 * 7")
	// The real bridge's save rewrites the file; simulate that so the stale guard has something to see.
	const onSave = async () => {
		await writeFile(path, (await Bun.file(path).text()).replace('"6 * 7"', '"6*7"'))
	}
	const server = await startBridgeServer(
		{ find: candidate => (candidate === path ? liveDocument("6 * 7", { onSave }) : undefined) },
		bridgeDirectory()
	)
	try {
		const result = await executeTool().execute("call", { path, index: 0 }, undefined, undefined, { cwd: home })
		expect(result.content).toEqual([
			{ type: "text", text: "Ran cell index 0 in VSCode. Outputs saved to disk." },
			{ type: "text", text: '<output index="0" type="execute_result">\n42\n</output>' }
		])
		await notebookEditCellTool.run({ path, index: 0, edits: [{ oldText: "6*7", newText: "6*8" }] })
	} finally {
		await server.close()
	}
})

test("notebook_execute_cell surfaces a source mismatch and says when outputs were not saved", async () => {
	const path = await notebookWith("x = 1")
	let live = liveDocument("x = 2")
	const server = await startBridgeServer({ find: candidate => (candidate === path ? live : undefined) }, bridgeDirectory())
	try {
		const tool = executeTool()
		await expect(tool.execute("call", { path, index: 0 }, undefined, undefined, { cwd: home })).rejects.toThrow(
			"differs from the notebook on disk"
		)
		live = liveDocument("x = 1", { dirty: true })
		const result = await tool.execute("call", { path, index: 0 }, undefined, undefined, { cwd: home })
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Ran cell index 0 in VSCode. Not saved: the VSCode copy has unsaved edits, so disk reads show old outputs until the user saves."
		})
	} finally {
		await server.close()
	}
})
