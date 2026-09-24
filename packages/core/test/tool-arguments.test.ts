import { expect, test } from "bun:test"
import { notebookInsertTool, notebookReadCellTool, parseToolArguments } from "../src/tools"

test("parseToolArguments names the allowed values of a wrong enum", () => {
	expect(() =>
		parseToolArguments(notebookInsertTool.params, { path: "a.ipynb", index: 0, direction: "below", type: "python", source: "" })
	).toThrow(
		'Invalid arguments:\n- direction: must be equal to one of the allowed values: "before", "after"\n- type: must be equal to one of the allowed values: "code", "markdown", "raw"'
	)
})

test("parseToolArguments converts stringly numbers and reports other problems plainly", () => {
	expect(parseToolArguments(notebookReadCellTool.params, { path: "a.ipynb", index: "3" })).toEqual({ path: "a.ipynb", index: 3 })
	expect(() => parseToolArguments(notebookReadCellTool.params, { path: "a.ipynb", index: -1 })).toThrow("- index: must be >= 0")
})
