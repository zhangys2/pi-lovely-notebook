import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { executeCell, type NotebookHost } from "./handlers"
import type { BridgeConnection, ExecuteCellRequest } from "./protocol"

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(chunk as Buffer)
	return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

/**
 * Listens on 127.0.0.1 at a random port and publishes `<dir>/<pid>.json` for pi to find. Bearer
 * token plus Host check: any local process or browser page can reach the port, only pi has the
 * token, and a rebound hostname never matches `127.0.0.1:<port>`.
 */
export async function startBridgeServer(host: NotebookHost, dir: string): Promise<{ close(): Promise<void> }> {
	const token = randomBytes(32).toString("hex")
	const expectedAuth = Buffer.from(`Bearer ${token}`)
	let port = 0

	const server = createServer(async (request, response) => {
		const reply = (status: number, value?: unknown) => {
			response.writeHead(status, { "content-type": "application/json" })
			response.end(value === undefined ? undefined : JSON.stringify(value))
		}
		if (request.headers.host !== `127.0.0.1:${port}`) return reply(403)
		const auth = Buffer.from(request.headers.authorization ?? "")
		if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) return reply(401)
		if (request.method !== "POST" || request.url !== "/execute-cell") return reply(404)

		// Pi aborting (Esc, its own timeout) closes the socket; that cancels the run.
		const aborted = new AbortController()
		response.on("close", () => {
			if (!response.writableFinished) aborted.abort()
		})
		const body = (await readJson(request)) as ExecuteCellRequest
		reply(200, await executeCell(host, body, aborted.signal))
	})

	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	port = (server.address() as AddressInfo).port
	await mkdir(dir, { recursive: true })
	const file = join(dir, `${process.pid}.json`)
	const connection: BridgeConnection = { pid: process.pid, port, token }
	await writeFile(file, JSON.stringify(connection), { mode: 0o600 })

	return {
		async close() {
			await rm(file, { force: true })
			await new Promise(resolve => server.close(resolve))
		}
	}
}
