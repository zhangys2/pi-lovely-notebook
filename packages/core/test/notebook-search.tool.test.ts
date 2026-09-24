import { expect, test } from "bun:test"
import { notebookReadOutputTool, notebookSearchTool } from "../src/tools"
import { copyFixture, createNotebookText, createTempNotebook, firstText } from "./helpers"

test("runNotebookSearch groups matching lines by cell with 1-based line numbers", async () => {
	const fixture = await createTempNotebook("search.ipynb", createNotebookText())
	try {
		const result = await notebookSearchTool.run({ path: fixture.path, pattern: "print\\(2\\)|title", ignoreCase: true })
		expect(firstText(result)).toBe(
			[
				'<cell index="0" id="intro" type="md">',
				"1: # Title",
				"</cell>",
				'<cell index="1" id="code-1" type="code">',
				"2: print(2)",
				"</cell>"
			].join("\n")
		)
	} finally {
		await fixture.cleanup()
	}
})

test("runNotebookSearch omits ids on no-id notebooks and reports no matches", async () => {
	const fixture = await copyFixture("lovely-test-no-ids.ipynb")
	try {
		expect(firstText(await notebookSearchTool.run({ path: fixture.path, pattern: "import" }))).toMatch(
			/^<cell index="\d+" type="code">\n\d+: /
		)
		expect(firstText(await notebookSearchTool.run({ path: fixture.path, pattern: "zzz-no-such-text" }))).toBe("[No matches]")
	} finally {
		await fixture.cleanup()
	}
})

test("runNotebookSearch with outputs finds output lines that feed back into notebook_read_cell_output", async () => {
	const fixture = await createTempNotebook(
		"outputs.ipynb",
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			cells: [
				{
					cell_type: "code",
					id: "c",
					source: "run()\n",
					outputs: [
						{ output_type: "stream", name: "stdout", text: ["step 1\n", "answer 42\n"] },
						{ output_type: "execute_result", data: { "image/png": "AAAA", "text/plain": ["header\n", "answer 42"] } },
						{ output_type: "error", ename: "E", evalue: "", traceback: ["\u001b[31mTraceback\u001b[0m", "E: answer 42"] }
					]
				}
			]
		})
	)
	try {
		expect(firstText(await notebookSearchTool.run({ path: fixture.path, pattern: "answer 42" }))).toBe("[No matches]")
		expect(firstText(await notebookSearchTool.run({ path: fixture.path, pattern: "answer 42", outputs: true }))).toBe(
			[
				'<cell index="0" id="c" type="code">',
				'<output index="0">',
				"2: answer 42",
				"</output>",
				'<output index="1" mime="text/plain">',
				"2: answer 42",
				"</output>",
				'<output index="2">',
				"2: E: answer 42",
				"</output>",
				"</cell>"
			].join("\n")
		)
		const read = await notebookReadOutputTool.run({ path: fixture.path, cellId: "c", outputIndex: 1, mime: "text/plain", lineOffset: 2 })
		expect(firstText(read)).toBe("answer 42")
	} finally {
		await fixture.cleanup()
	}
})
