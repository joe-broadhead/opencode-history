import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { createPlugin } from "./host/plugin.js"
import { createRuntime } from "./runtime.js"

// One level below the package root both as source (src/) and as the bundle (dist/).
export default Plugin.define(createPlugin({ createRuntime, packageRoot: fileURLToPath(new URL("../", import.meta.url)) }))
