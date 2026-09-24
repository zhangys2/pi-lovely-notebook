import { expect, test } from "bun:test"
import { notebookSearchTool } from "../src/tools"
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
