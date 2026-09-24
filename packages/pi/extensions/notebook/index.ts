import { dirname, isAbsolute, resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { generateDiffString, keyHint, renderDiff, resizeImage, withFileMutationQueue } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import {
	loadNotebook,
	type NotebookSourceChangeObserver,
	type NotebookToolContent,
	notebookChangeCellTypeTool,
	notebookClearOutputsTool,
	notebookCreateTool,
	notebookDeleteTool,
	notebookEditCellTool,
	notebookInsertTool,
	notebookMergeTool,
	notebookMoveTool,
	notebookReadCellAttachmentTool,
	notebookReadCellTool,
	notebookReadOutputTool,
	notebookSearchTool,
	notebookSummaryTool,
	notebookToolGuidelines,
	notebookWriteCellTool,
	parseToolArguments
} from "@xl0/lovely-notebook"
import { type TSchema, Type } from "typebox"

type NotebookRenderTheme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>[1]
type NotebookRenderArgs = {
	path?: string
	pattern?: string
	cellId?: string
	index?: number
	targetCellId?: string
	targetIndex?: number
	outputIndex?: number
	mime?: string
	key?: string
	type?: "code" | "markdown" | "raw"
	direction?: "before" | "after" | "above" | "below"
	lineOffset?: number
	lineLimit?: number
	includeImages?: boolean
	language?: string
}
type NotebookDiffDetails = ReturnType<typeof generateDiffString>
type NotebookToolRenderResult = { content: NotebookToolContent; details: NotebookDiffDetails | undefined }

// Core returns raw images; resize them into provider limits here, at the pi seam.
export async function resolveContentImages(content: NotebookToolContent): Promise<NotebookToolContent> {
	const resolved: NotebookToolContent = []
	for (const item of content) {
		if (item.type !== "image") {
			resolved.push(item)
			continue
		}
		const resized = await resizeImage(Buffer.from(item.data, "base64"), item.mimeType)
		if (resized) {
			resolved.push({ type: "image", data: resized.data, mimeType: resized.mimeType })
		} else {
			resolved.push({ type: "text", text: "[Image omitted: could not be resized below the inline image size limit.]" })
		}
	}
	return resolved
}

function shortPath(path: string | undefined): string | undefined {
	if (!path) return undefined
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function formatArg(name: string, value: string | number | boolean | undefined): string | undefined {
	if (value === undefined || value === "") return undefined
	return `${name}=${String(value)}`
}

function renderNotebookCall(name: string, args: NotebookRenderArgs, theme: NotebookRenderTheme): Text {
	const parts = [
		shortPath(args.path),
		formatArg("pattern", args.pattern),
		formatArg("cell", args.cellId ?? args.index),
		formatArg("target", args.targetCellId ?? args.targetIndex),
		formatArg("out", args.outputIndex),
		formatArg("mime", args.mime),
		formatArg("key", args.key),
		formatArg("type", args.type),
		formatArg("dir", args.direction),
		formatArg("offset", args.lineOffset),
		formatArg("limit", args.lineLimit),
		formatArg("images", args.includeImages),
		formatArg("language", args.language)
	].filter(part => part !== undefined)

	const text =
		parts.length > 0
			? `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", parts.join(" "))}`
			: theme.fg("toolTitle", theme.bold(name))
	return new Text(text, 0, 0)
}

function renderNotebookReadCall(name: string, args: NotebookRenderArgs, theme: NotebookRenderTheme): Text {
	const rawPath = shortPath(args.path)
	let pathDisplay = rawPath ? theme.fg("accent", rawPath) : theme.fg("toolOutput", "...")
	if (args.lineOffset !== undefined || args.lineLimit !== undefined) {
		const startLine = typeof args.lineOffset === "number" ? args.lineOffset : 1
		const endLine = typeof args.lineLimit === "number" ? startLine + args.lineLimit - 1 : ""
		pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`)
	}

	const cell = formatArg("cell", args.cellId ?? args.index)
	const suffix = cell ? ` ${theme.fg("dim", cell)}` : ""
	return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${pathDisplay}${suffix}`, 0, 0)
}

function renderNotebookTextResult(result: NotebookToolRenderResult, expanded: boolean, theme: NotebookRenderTheme): Text {
	const output = result.content.find(item => item.type === "text")?.text ?? ""
	const lines = output.split("\n")
	let end = lines.length
	while (end > 0 && lines[end - 1] === "") end--

	const trimmed = lines.slice(0, end)
	const maxLines = expanded ? trimmed.length : 10
	const displayLines = trimmed.slice(0, maxLines)
	const remaining = trimmed.length - maxLines
	let text = `\n${displayLines.map(line => theme.fg("toolOutput", line)).join("\n")}`
	if (remaining > 0) text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`
	return new Text(text, 0, 0)
}

function renderNotebookDiffResult(result: NotebookToolRenderResult, expanded: boolean, theme: NotebookRenderTheme): Text {
	return result.details?.diff ? new Text(renderDiff(result.details.diff), 0, 0) : renderNotebookTextResult(result, expanded, theme)
}

type AnyNotebookTool = {
	name: string
	description: string
	params: TSchema
	run: (params: never, onChange?: NotebookSourceChangeObserver) => Promise<NotebookToolContent>
}

type NotebookToolEntry = {
	tool: AnyNotebookTool
	label: string
	promptSnippet: string
	readStyleRender?: boolean
	renderResult?: "text" | "diff"
	promptGuidelines?: string[]
}

const notebookTools: NotebookToolEntry[] = [
	{
		tool: notebookSummaryTool,
		label: "Notebook Summary",
		promptSnippet: "Discover existing cells",
		readStyleRender: true,
		renderResult: "text",
		// Shared semantics live once, namespaced on notebook_summary, so deduped
		// system-prompt guidance keeps notebook scope clear.
		promptGuidelines: notebookToolGuidelines
	},
	{
		tool: notebookSearchTool,
		label: "Notebook Search",
		promptSnippet: "Find cells and source lines matching a regex; returns cell ids and 1-based line numbers.",
		renderResult: "text"
	},
	{
		tool: notebookCreateTool,
		label: "Notebook Create",
		promptSnippet: "Create a new empty .ipynb notebook. Fails if the path already exists."
	},
	{
		tool: notebookReadCellTool,
		label: "Notebook Read Cell",
		promptSnippet: "Read one notebook cell source, optionally by line slice.",
		readStyleRender: true
	},
	{
		tool: notebookWriteCellTool,
		label: "Notebook Write Cell",
		promptSnippet: "Replace one notebook cell source, optionally changing its type.",
		renderResult: "diff"
	},
	{
		tool: notebookChangeCellTypeTool,
		label: "Notebook Change Cell Type",
		promptSnippet: "Change one notebook cell between code, markdown, and raw."
	},
	{
		tool: notebookEditCellTool,
		label: "Notebook Edit Cell",
		promptSnippet: "Edit part of one notebook cell with exact text replacements.",
		renderResult: "diff"
	},
	{
		tool: notebookInsertTool,
		label: "Notebook Insert",
		promptSnippet: "Insert a new code, markdown, or raw cell near an existing anchor.",
		renderResult: "diff"
	},
	{
		tool: notebookDeleteTool,
		label: "Notebook Delete",
		promptSnippet: "Delete one notebook cell.",
		renderResult: "diff"
	},
	{
		tool: notebookMoveTool,
		label: "Notebook Move",
		promptSnippet: "Move one notebook cell before or after another."
	},
	{
		tool: notebookMergeTool,
		label: "Notebook Merge",
		promptSnippet: "Merge one notebook cell with the cell above or below.",
		renderResult: "diff"
	},
	{
		tool: notebookClearOutputsTool,
		label: "Notebook Clear Outputs",
		promptSnippet: "Remove outputs from one code cell."
	},
	{
		tool: notebookReadOutputTool,
		label: "Notebook Read Cell Output",
		promptSnippet:
			"Read one cell output; omit outputIndex when the cell has a single output. Use notebook_summary first to discover available outputs and their mime types."
	},
	{
		tool: notebookReadCellAttachmentTool,
		label: "Notebook Read Cell Attachment",
		promptSnippet: "Read a cell attachment image. Use notebook_summary first to discover available attachment keys (atts attribute)."
	}
]

const notebookRunAllParams = Type.Object({
	path: Type.String({ description: "Path to an .ipynb notebook." }),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "Limit for the whole run, in seconds. Defaults to 600." }))
})

export default function notebookExtension(pi: ExtensionAPI) {
	// Guidelines alone don't stop models reaching for read/edit on a notebook; they get escaped
	// JSON, and a raw-JSON edit bypasses every structural check the notebook tools make.
	pi.on("tool_call", event => {
		if (!["read", "edit", "write", "grep"].includes(event.toolName)) return undefined
		const { path, glob } = event.input as { path?: unknown; glob?: unknown }
		const targets = [path, glob].filter(value => typeof value === "string")
		if (!targets.some(target => /\.ipynb$/i.test(target))) return undefined
		return {
			block: true,
			reason: `${event.toolName} on .ipynb sees escaped JSON, not cells. Use notebook_summary, notebook_search, notebook_read_cell or the notebook edit tools instead.`
		}
	})

	for (const entry of notebookTools) {
		const { tool } = entry
		pi.registerTool({
			name: tool.name,
			label: entry.label,
			description: tool.description,
			promptSnippet: entry.promptSnippet,
			...(entry.promptGuidelines && { promptGuidelines: entry.promptGuidelines }),
			parameters: tool.params,
			// Runs before pi's own validation, whose enum errors don't name the allowed values.
			prepareArguments: args => parseToolArguments(tool.params, args),
			renderCall: (args, theme) =>
				entry.readStyleRender
					? renderNotebookReadCall(tool.name, args as NotebookRenderArgs, theme)
					: renderNotebookCall(tool.name, args as NotebookRenderArgs, theme),
			...(entry.renderResult && {
				renderResult: (result: NotebookToolRenderResult, { expanded }: { expanded: boolean }, theme: NotebookRenderTheme) =>
					entry.renderResult === "diff"
						? renderNotebookDiffResult(result, expanded, theme)
						: renderNotebookTextResult(result, expanded, theme)
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const rawPath = (params as { path: string }).path
				const path = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath)
				return withFileMutationQueue(path, async (): Promise<NotebookToolRenderResult> => {
					let details: NotebookDiffDetails | undefined
					const content = await tool.run({ ...(params as object), path } as never, change => {
						details = generateDiffString(change.before, change.after)
					})
					return { content: await resolveContentImages(content), details }
				})
			}
		})
	}

	// Interim execution: a fresh kernel per run through nbconvert, so no kernel state lives in pi.
	// The VSCode bridge in PLAN.md is the real answer for per-cell runs in the user's kernel.
	pi.registerTool({
		name: "notebook_run_all",
		label: "Notebook Run All",
		description:
			"Run every cell of a notebook top to bottom in a fresh Jupyter kernel and save the outputs. Requires Jupyter (jupyter nbconvert) on PATH.",
		promptSnippet: "Run a whole notebook in a fresh kernel and save its outputs.",
		promptGuidelines: [
			"notebook_run_all: fresh kernel every run, nothing carries over; cells after an error still run, so fix the first error first; needs Jupyter installed."
		],
		parameters: notebookRunAllParams,
		prepareArguments: args => parseToolArguments(notebookRunAllParams, args),
		renderCall: (args, theme) => renderNotebookCall("notebook_run_all", args as NotebookRenderArgs, theme),
		renderResult: (result, { expanded }, theme) => renderNotebookTextResult(result as NotebookToolRenderResult, expanded, theme),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path)
			const timeoutSeconds = params.timeoutSeconds ?? 600
			return withFileMutationQueue(path, async (): Promise<NotebookToolRenderResult> => {
				// --allow-errors: without it nbconvert writes nothing at all on the first error.
				// timeout=-1: the default 30s per cell kills real work; the whole run is bounded instead.
				// record_timing=False: otherwise every cell gains timestamp metadata, churning git diffs.
				const args = ["nbconvert", "--to", "notebook", "--execute", "--inplace", "--allow-errors"]
				args.push("--ExecutePreprocessor.timeout=-1", "--ExecutePreprocessor.record_timing=False", path)
				const result = await pi.exec("jupyter", args, { cwd: dirname(path), timeout: timeoutSeconds * 1000, ...(signal && { signal }) })
				if (result.killed) throw new Error(`Run stopped (timed out after ${timeoutSeconds}s or aborted); ${path} was left unchanged.`)
				if (result.code !== 0) {
					const stderr = result.stderr.trim().split("\n").slice(-20).join("\n")
					throw new Error(`jupyter nbconvert exited with code ${result.code}. Is Jupyter installed and on PATH?\n${stderr}`)
				}
				const notebook = await loadNotebook(path)
				const failed = notebook.cells.flatMap((cell, index) =>
					cell.outputs?.some(output => output.output_type === "error") ? [cell.id ?? `index ${index}`] : []
				)
				const status =
					failed.length === 0
						? `Ran ${path}: no errors.`
						: `Ran ${path}: errors in cell(s) ${failed.join(", ")}. Cells after the first error still ran.`
				// Reading through the summary tool also re-arms the stale guard for the file nbconvert rewrote.
				return { content: [{ type: "text", text: status }, ...(await notebookSummaryTool.run({ path }))], details: undefined }
			})
		}
	})
}
