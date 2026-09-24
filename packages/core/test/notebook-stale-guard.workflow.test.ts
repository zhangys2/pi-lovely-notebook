import { expect, test } from "bun:test"
import { readFile, utimes, writeFile } from "node:fs/promises"
import { notebookEditCellTool, notebookReadCellTool, notebookWriteCellTool } from "../src/tools"
import { createNotebookText, createTempNotebook, firstText } from "./helpers"

async function saveFromEditor(path: string, from: string, to: string) {
	await writeFile(path, (await readFile(path, "utf8")).replace(from, to))
	// Same-size edits inside one mtime tick would be invisible; editors don't save that fast.
	const future = new Date(Date.now() + 5000)
	await utimes(path, future, future)
}

test("a mutation after an outside save is refused until the notebook is re-read", async () => {
	const fixture = await createTempNotebook("stale.ipynb", createNotebookText())
	const edit = { path: fixture.path, cellId: "code-1", edits: [{ oldText: "print(2)", newText: "print(3)" }] }
	try {
		await notebookReadCellTool.run({ path: fixture.path, cellId: "code-1" })
		await saveFromEditor(fixture.path, "print(2)", "print(9)")

		await expect(notebookEditCellTool.run(edit)).rejects.toThrow("changed on disk since it was last read")

		expect(firstText(await notebookReadCellTool.run({ path: fixture.path, cellId: "code-1" }))).toBe("print(1)\nprint(9)\n")
		await expect(notebookEditCellTool.run(edit)).rejects.toThrow("Edit text not found")
		await notebookWriteCellTool.run({ path: fixture.path, cellId: "code-1", source: "print(3)\n" })
		expect(firstText(await notebookReadCellTool.run({ path: fixture.path, cellId: "code-1" }))).toBe("print(3)\n")
	} finally {
		await fixture.cleanup()
	}
})

test("consecutive mutations do not trip over their own writes", async () => {
	const fixture = await createTempNotebook("own.ipynb", createNotebookText())
	try {
		await notebookReadCellTool.run({ path: fixture.path, cellId: "code-1" })
		await notebookWriteCellTool.run({ path: fixture.path, cellId: "code-1", source: "a\n" })
		await notebookWriteCellTool.run({ path: fixture.path, cellId: "code-1", source: "b\n" })
		expect(firstText(await notebookReadCellTool.run({ path: fixture.path, cellId: "code-1" }))).toBe("b\n")
	} finally {
		await fixture.cleanup()
	}
})
