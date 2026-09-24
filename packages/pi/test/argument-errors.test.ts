import { expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import notebookExtension from "../extensions/notebook"

test("notebook tools pre-validate arguments with messages that name allowed enum values", () => {
	const tools: Array<{ name: string; prepareArguments: (args: unknown) => unknown }> = []
	notebookExtension({ on: () => {}, registerTool: (tool: (typeof tools)[number]) => tools.push(tool) } as unknown as ExtensionAPI)
	const insert = tools.find(tool => tool.name === "notebook_insert")
	expect(() => insert?.prepareArguments({ path: "a.ipynb", index: 0, direction: "below", type: "code", source: "" })).toThrow(
		'direction: must be equal to one of the allowed values: "before", "after"'
	)
})
