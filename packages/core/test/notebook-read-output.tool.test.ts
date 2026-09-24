import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { formatCellOutputs, notebookReadOutputTool, notebookSummaryTool } from "../src/tools"
import { createTempNotebook, FIXTURE_DIR, firstText } from "./helpers"

test("formatCellOutputs renders loose outputs like reads do, one element per output, images after", () => {
	const content = formatCellOutputs([
		{ output_type: "stream", name: "stdout", text: "\u001b[1m42\u001b[0m\n" },
		{ output_type: "display_data", data: { "image/png": "AAAA", "text/plain": "<Figure>" }, metadata: {} },
		{ output_type: "error", ename: "E", evalue: "", traceback: ["E: boom"] }
	])
	expect(content).toEqual([
		{
			type: "text",
			text: [
				'<output index="0" type="stream">',
				"42",
				"</output>",
				'<output index="1" type="display_data">',
				'<output mime="image/png" />',
				'<output mime="text/plain">',
				"<Figure>",
				"</output>",
				"</output>",
				'<output index="2" type="error">',
				"E: boom",
				"</output>"
			].join("\n")
		},
		{ type: "image", data: "AAAA", mimeType: "image/png" }
	])
	expect(formatCellOutputs([])).toEqual([{ type: "text", text: "[No outputs]" }])
})

test("error and stream outputs are read without ANSI colour codes, which stay in the file", async () => {
	const text = JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		cells: [
			{
				cell_type: "code",
				id: "c",
				source: "1/0\n",
				outputs: [
					{ output_type: "stream", name: "stderr", text: ["\u001b[33mwarn\u001b[0m\n"] },
					{
						output_type: "error",
						ename: "ZeroDivisionError",
						evalue: "division by zero",
						traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"]
					}
				]
			}
		]
	})
	const fixture = await createTempNotebook("ansi.ipynb", text)
	try {
		expect(firstText(await notebookReadOutputTool.run({ path: fixture.path, cellId: "c", outputIndex: 0 }))).toBe("warn\n")
		expect(firstText(await notebookReadOutputTool.run({ path: fixture.path, cellId: "c", outputIndex: 1 }))).toBe(
			"ZeroDivisionError: division by zero"
		)
		expect(firstText(await notebookSummaryTool.run({ path: fixture.path }))).not.toContain("\u001b")
		expect(await readFile(fixture.path, "utf8")).toBe(text)
	} finally {
		await fixture.cleanup()
	}
})

test("runNotebookReadOutput labels each mime variant and wraps repr-like text", async () => {
	const fixture = await createTempNotebook(
		"multi.ipynb",
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			cells: [
				{
					cell_type: "code",
					id: "c",
					source: "obj\n",
					outputs: [{ output_type: "execute_result", data: { "image/png": "AAAA", "text/plain": ["<module.Proxy>"] } }]
				}
			]
		})
	)

	try {
		// Image variants carry no text, so they self-close; the repr stays inside its element.
		const result = await notebookReadOutputTool.run({ path: fixture.path, cellId: "c", outputIndex: 0, includeImages: false })
		expect(firstText(result)).toBe('<output mime="image/png" />\n<output mime="text/plain">\n<module.Proxy>\n</output>')
	} finally {
		await fixture.cleanup()
	}
})

test("runNotebookReadOutput treats svg as an image, and returns the markup only when asked", async () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg">\n${"  <path d='M0 0' />\n".repeat(200)}</svg>`
	const fixture = await createTempNotebook(
		"plot.ipynb",
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			cells: [
				{
					cell_type: "code",
					id: "c",
					source: "plot()\n",
					outputs: [{ output_type: "display_data", data: { "image/svg+xml": svg, "text/plain": ["<Figure>"] } }]
				}
			]
		})
	)

	try {
		const result = await notebookReadOutputTool.run({ path: fixture.path, cellId: "c" })
		expect(firstText(result)).toBe('<output mime="image/svg+xml" />\n<output mime="text/plain">\n<Figure>\n</output>')
		const markup = await notebookReadOutputTool.run({ path: fixture.path, cellId: "c", mime: "image/svg+xml", lineLimit: 1 })
		expect(firstText(markup)).toBe('<svg xmlns="http://www.w3.org/2000/svg">\n[201 more lines. Use offset=2 to continue.]')
	} finally {
		await fixture.cleanup()
	}
})

test("runNotebookReadOutput uses 0-based output indices", async () => {
	const path = join(FIXTURE_DIR, "lovely-history.ipynb")
	const result = await notebookReadOutputTool.run({ path, index: 4, outputIndex: 0, mime: "text/plain" })

	expect(firstText(result)).toBe("tensor(10, device='cuda:0')")
	await expect(notebookReadOutputTool.run({ path, index: 4, outputIndex: -1 })).rejects.toThrow("Output index out of range: -1")
})

test("runNotebookReadOutput defaults to the only output, and refuses to guess when there are several", async () => {
	const path = join(FIXTURE_DIR, "lovely-history.ipynb")
	expect(firstText(await notebookReadOutputTool.run({ path, index: 4 }))).toBe("tensor(10, device='cuda:0')")

	const fixture = await createTempNotebook(
		"two-outputs.ipynb",
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			cells: [
				{
					cell_type: "code",
					id: "c",
					source: "run()\n",
					outputs: [
						{ output_type: "stream", name: "stdout", text: ["log\n"] },
						{ output_type: "execute_result", data: { "text/plain": ["42"] } }
					]
				}
			]
		})
	)

	try {
		await expect(notebookReadOutputTool.run({ path: fixture.path, cellId: "c" })).rejects.toThrow(
			"Cell index 0 has 2 outputs; pass outputIndex (0-1)"
		)
		expect(firstText(await notebookReadOutputTool.run({ path: fixture.path, cellId: "c", outputIndex: 1 }))).toBe("42")
	} finally {
		await fixture.cleanup()
	}
})

test("runNotebookReadOutput returns raw image outputs", async () => {
	const result = await notebookReadOutputTool.run({
		path: join(FIXTURE_DIR, "subtly-corrupt-images.ipynb"),
		cellId: "corrupt-output",
		outputIndex: 0,
		mime: "image/png"
	})
	expect(result).toHaveLength(1)
	expect(result[0]?.type).toBe("image")
	expect(result[0]?.type === "image" && result[0].mimeType).toBe("image/png")
})

test("runNotebookReadOutput can omit image content", async () => {
	const result = await notebookReadOutputTool.run({
		path: join(FIXTURE_DIR, "subtly-corrupt-images.ipynb"),
		cellId: "corrupt-output",
		outputIndex: 0,
		mime: "image/png",
		includeImages: false
	})
	expect(result).toEqual([{ type: "text", text: "[Images omitted: includeImages=false.]" }])
})
