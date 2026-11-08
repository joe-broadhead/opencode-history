import type { Plugin } from "@opencode/plugin"
import { formatFailure, HistoryError } from "../domain/common.js"
import { loadConfig } from "../domain/config.js"
import { PLUGIN_ID } from "../domain/contract.js"
import { INDEX_PATH_MESSAGES, indexPathProblem } from "../domain/paths.js"
import { History } from "../rpc.js"
import { VERSION } from "../version.js"
import { commandTransform } from "./commands.js"
import { TESTED_HOSTS } from "../domain/hosts.js"
import { checkHost, inRange } from "./compat.js"
import { registerDefaultRules, type Rule } from "./permissions.js"
import { followEvents } from "./events.js"
import { rpcHandlers } from "./rpc-handlers.js"
import type { CreateRuntime } from "./runtime.js"
import { loadSkills, skillTransform } from "./skills.js"
import { buildStatus, fallbackFailure } from "./status.js"
import { toolTransform, type ToolSources } from "./tools.js"
import { registerToolsRpc, scriptMethods } from "./tools-rpc.js"

interface PluginSources {
  readonly createRuntime: CreateRuntime
  /** The installed package root, which holds skills/. */
  readonly packageRoot: string
}

/** A failure that stops setup, with its code in the text, since the host logs only the message. Other errors pass. */
function setupFailure(error: unknown) {
  if (!(error instanceof HistoryError)) return error
  return Object.assign(new Error(formatFailure(error)), { code: error.code, ...error.hint ? { hint: error.hint } : {} })
}

export function createPlugin({ createRuntime, packageRoot }: PluginSources): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const config = loadConfig(ctx.options)
      const host = checkHost(ctx.app.version, config.allowUntestedHost)
      if (!host.tested) {
        const why = inRange(host.version ?? "") ? `inside the supported range ${host.range}` : `outside the supported range ${host.range}; History runs because allowUntestedHost is set`
        console.warn(formatFailure({ code: "HOST_UNTESTED", message: `OpenCode ${host.version ?? "of no known version"} is untested (tested: ${TESTED_HOSTS.join(", ")}), ${why}.`, hint: "Use a tested OpenCode version if something fails." }))
      }
      // Refuse a dangerous indexPath before anything opens it. Options may come from a project's own opencode.json.
      const problem = indexPathProblem(config.indexPath, {
        database: config.database,
        projectFolders: [ctx.location.directory, ctx.location.project.directory],
        custom: typeof (ctx.options as { indexPath?: unknown } | undefined)?.indexPath === "string",
      })
      if (problem) throw setupFailure(new HistoryError("INDEX_PATH_REFUSED", { message: INDEX_PATH_MESSAGES[problem] }))
      const version = VERSION
      const runtime = await createRuntime({ config, session: ctx.session }).catch((error: unknown) => { throw setupFailure(error) })
      if (runtime.fallback) console.warn(formatFailure(fallbackFailure(runtime.fallback)))
      const shutdown = new AbortController()
      let stopToolsRpc = async () => {}
      const close = async () => { shutdown.abort(); await stopToolsRpc(); await runtime.close() }
      try {
        const location = { projectID: ctx.location.project.id, directory: ctx.location.directory }
        const defaults = { scope: config.defaultScope }
        const agents = async () => (await ctx.agent.list({ location: { directory: ctx.location.directory } })).data as readonly { id: string; permissions: Rule[] }[]
        const skills = await loadSkills(packageRoot)
        const listedSkills = async () => (await ctx.skill.list({ location: { directory: ctx.location.directory } })).data.map(skill => ({ id: String(skill.id), path: String(skill.path) }))
        const status = () => buildStatus({
          version, host, config, runtime, agents, tools: () => ctx.tool.list(),
          skills: { listed: listedSkills, own: skills.map(skill => ({ id: skill.id, path: skill.info.path })) },
        })
        const assert = (request: Parameters<typeof ctx.permission.assert>[0]) => ctx.permission.assert(request)
        const sources: ToolSources = { runtime, session: ctx.session, location, defaults, assert: request => assert(request as never) }
        await registerDefaultRules(ctx.agent, config.access)
        await ctx.tool.transform(toolTransform(sources))
        await ctx.rpc.register(History, rpcHandlers({ status }))
        stopToolsRpc = await registerToolsRpc(ctx, { methods: scriptMethods(sources) })
        await ctx.command.transform(commandTransform({ synthetic: input => ctx.session.synthetic(input), runtime, status }))
        await ctx.skill.transform(skillTransform(skills))
        // Session events keep the index fresh. The loop ends when the plugin unloads.
        void followEvents(options => ctx.event.subscribe(options), event => runtime.onEvent(event), shutdown.signal)
        return close
      } catch (error) {
        await close().catch(() => undefined)
        throw error
      }
    },
  }
}
