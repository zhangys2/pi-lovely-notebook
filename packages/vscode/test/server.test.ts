import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostDocument } from "../src/handlers"
import type { BridgeConnection } from "../src/protocol"
import { startBridgeServer } from "../src/server"

const document: HostDocument = {
	isDirty: true,
	cells: () => [{ id: "a", source: "1\n" }],
	hasRunningKernel: async () => true,
	execute: async () => "done",
	outputs: () => [],
	save: async () => {}
}

async function withServer(run: (connection: BridgeConnection, dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "bridge-server-"))
	const server = await startBridgeServer({ find: path => (path === "/nb.ipynb" ? document : undefined) }, dir)
	try {
		const connection = JSON.parse(await readFile(join(dir, `${process.pid}.json`), "utf8")) as BridgeConnection
		await run(connection, dir)
	} finally {
		await server.close()
		expect(await readdir(dir)).toEqual([])
		await rm(dir, { recursive: true, force: true })
	}
}

const body = JSON.stringify({ path: "/nb.ipynb", cellId: "a", expectedSource: "1\n", timeoutSeconds: 5 })

test("publishes a connection file and serves execute-cell to the token holder", async () => {
	await withServer(async connection => {
		expect(connection.pid).toBe(process.pid)
		const response = await fetch(`http://127.0.0.1:${connection.port}/execute-cell`, {
			method: "POST",
			headers: { authorization: `Bearer ${connection.token}` },
			body
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: true, index: 0, outputs: [], saved: false })
	})
})

test("rejects a wrong token, a foreign Host header, and unknown routes", async () => {
	await withServer(async connection => {
		const url = `http://127.0.0.1:${connection.port}`
		const auth = { authorization: `Bearer ${connection.token}` }
		expect((await fetch(`${url}/execute-cell`, { method: "POST", headers: { authorization: "Bearer nope" }, body })).status).toBe(401)
		// DNS rebinding: a browser page reaching the port by another hostname sends that Host.
		expect((await fetch(`${url}/execute-cell`, { method: "POST", headers: { ...auth, host: "evil.test" }, body })).status).toBe(403)
		expect((await fetch(`${url}/other`, { method: "POST", headers: auth, body })).status).toBe(404)
	})
})
