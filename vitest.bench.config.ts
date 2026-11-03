import { defineConfig } from "vitest/config"

export default defineConfig({ test: { include: ["test/bench/**/*.test.ts"], testTimeout: 600000, hookTimeout: 3600000, fileParallelism: false } })
