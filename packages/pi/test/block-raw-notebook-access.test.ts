import { expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import notebookExtension from "../extensions/notebook"

type ToolCallHandler = (event: { toolName: string; input: object }) => { block: true; reason: string } | undefined

function toolCallHandler(): ToolCallHandler {
	let handler: ToolCallHandler | undefined
	notebookExtension({ on: (_event: string, fn: ToolCallHandler) => (handler = fn), registerTool: () => {} } as unknown as ExtensionAPI)
	if (!handler) throw new Error("tool_call handler not registered")
	return handler
}

test("generic file tools are blocked on notebooks and pointed at notebook tools", () => {
	const handle = toolCallHandler()
	for (const [toolName, input] of [
		["read", { path: "a/b.ipynb" }],
		["edit", { path: "B.IPYNB", edits: [] }],
		["write", { path: "c.ipynb", content: "{}" }],
		["grep", { pattern: "x", glob: "**/*.ipynb" }]
	] as const) {
		expect(handle({ toolName, input })?.reason).toContain("notebook_search")
	}
})

test("other files and tools pass through", () => {
	const handle = toolCallHandler()
	expect(handle({ toolName: "read", input: { path: "notes.ipynb.md" } })).toBeUndefined()
	expect(handle({ toolName: "grep", input: { pattern: "x", path: "src" } })).toBeUndefined()
	expect(handle({ toolName: "bash", input: { command: "cat a.ipynb" } })).toBeUndefined()
})
