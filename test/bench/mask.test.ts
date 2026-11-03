// How fast the built-in mask patterns run over indexed text, and over input built to make a regex backtrack. Every
// message passes through them before it is stored, so a full pass masks the whole history once.
import { expect, test } from "vitest"
import { DEFAULT_MASK, maskText } from "../../src/extract/index.js"
import { corpus } from "./corpus.js"

/** The most a megabyte of text may take. */
const MS_PER_MB = 100

test("built-in masks over synthetic session text", () => {
  const text = corpus({ docs: 20_000 }).docs.map(doc => doc.text).join("\n")
  const started = performance.now()
  maskText(text, DEFAULT_MASK)
  const perMB = (performance.now() - started) / (text.length / 1_048_576)
  console.log(`built-in masks: ${perMB.toFixed(1)} ms per MB of text`)
  expect(perMB).toBeLessThan(MS_PER_MB)
})

test("built-in masks over input built to backtrack", () => {
  for (const [name, text] of [
    ["one long word", "a".repeat(1_000_000)],
    ["underscored words", "a_".repeat(500_000)],
    ["setting names without values", "password_".repeat(100_000)],
    ["quoted setting names", `"password": "`.repeat(80_000)],
    ["an unterminated private key", `-----BEGIN RSA PRIVATE KEY-----\n${"x".repeat(1_000_000)}`],
    ["Bearer without tokens", "Bearer ".repeat(100_000)],
    ["JWT starts", "eyJ".repeat(300_000)],
  ] as const) {
    const started = performance.now()
    maskText(text, DEFAULT_MASK)
    const ms = performance.now() - started
    console.log(`${name}: ${ms.toFixed(0)} ms for ${(text.length / 1_048_576).toFixed(1)} MB`)
    expect(ms, name).toBeLessThan(MS_PER_MB * 2)
  }
})
