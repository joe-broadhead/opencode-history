import { HOST_VERSION, project, removeRoot, root, startHost, waitFor, withOptions } from "./harness.js"
import { createServer } from "node:http"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { afterAll, expect, test } from "vitest"
import { Plugin } from "@opencode/plugin"
import * as z from "zod"
import plugin from "../../src/index.js"

test("the forced History catalogue stays under 1,000 tokens", async () => {
  let captured = ""
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as { messages?: { role: string; content?: unknown }[] }
    captured = (body.messages ?? []).filter(item => item.role === "system").map(item => typeof item.content === "string" ? item.content : "").join("\n")
    response.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    response.write(chunk({ role: "assistant", content: "ok" }))
    response.write(chunk({}, "stop"))
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const database = join(root, "catalogue.db"), directory = project("catalogue")
  let context: Plugin.Context | undefined
  const filler = Plugin.define({
    id: "history.catalogue.filler",
    async setup(ctx) {
      context = ctx
      await ctx.tool.transform(editor => {
        editor.namespace({ name: "filler", description: "Spends the inline budget." })
        editor.add({ name: "pad", description: "pad", input: z.object({ note: z.string().describe("x".repeat(9000)) }), options: { namespace: "filler", permission: "filler_pad", pinned: true }, execute: async () => ({ content: "ok" }) } as never)
      })
    },
  })
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  try {
    host = await startHost([withOptions(plugin, { database, indexPath: join(root, "catalogue-index.db") }), filler], database, HOST_VERSION, {
      providers: { scripted: { name: "Scripted", package: ["@opencode", "ai", "providers", "openai-compatible"].join("/"), settings: { baseURL, apiKey: "test" }, models: { m1: { name: "Mock", capabilities: { tools: true } } } } },
      model: "scripted/m1",
    })
    await waitFor(() => host!.sdk.agent.list({ location: { directory } }).then(() => Boolean(context), () => false), 30_000, "the plugin to load")
    const session = await host.sdk.session.create({ location: { directory }, agent: "build" } as never)
    await host.sdk.session.prompt({ sessionID: session.id, text: "Reply with ok." } as never)
    await waitFor(() => captured.includes("- history ("), 30_000, "the catalogue")
    const lines = captured.split("\n"), start = lines.findIndex(line => line.startsWith("- history ("))
    const section = start < 0 ? [] : [lines[start]!]
    for (let i = start + 1; start >= 0 && i < lines.length && lines[i]!.startsWith("  "); i++) section.push(lines[i]!)
    const text = section.join("\n")
    expect(text).toContain("history-recall")
    expect(Math.round(text.length / 4)).toBeLessThanOrEqual(1000)
  } finally {
    await host?.sdk.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 120_000)

afterAll(() => removeRoot())
