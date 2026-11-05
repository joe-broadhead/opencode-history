import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import { formatFailure, HistoryError, logUnexpected } from "../domain/common.js"
import type { History } from "../rpc.js"
import { isFailure } from "./errors.js"
import { StatusSchema } from "../domain/schemas.js"
import type { StatusView } from "./status.js"

export interface RpcSources { readonly status: () => Promise<StatusView> }

/**
 * The status RPC. A failure answers `failed` with the code, the text and the next step. The tools are scripted through
 * the tools RPC (scripting.ts), which runs them as a session and its agent.
 */
export function rpcHandlers(sources: RpcSources): RpcHandlers<typeof History> {
  return {
    status: async (_input, context) => {
      try { return StatusSchema.parse(await sources.status()) } catch (error) {
        const failure = isFailure(error) ? error : new HistoryError("STATUS_UNAVAILABLE")
        if (!isFailure(error)) logUnexpected(error, "STATUS_UNAVAILABLE", "rpc.status")
        return context.error("failed", formatFailure(failure), { code: failure.code, next: failure.hint ?? "" })
      }
    },
  }
}
