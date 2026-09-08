/**
 * Minimal .env.local loader.
 *
 * Next.js loads .env.local automatically, but the CLI scripts (`npm run ingest`,
 * `npm run demo`) run under tsx and do not. Rather than add a dependency for
 * twenty lines, this parses the file directly. Existing environment variables
 * always win, so `ANTHROPIC_API_KEY=... npm run demo` overrides the file.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (!existsSync(file)) continue;

    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export const config = {
  /** Model id in use. Resolved by lib/model.ts from whichever key is present. */
  get model() {
    loadEnv();
    if (process.env.CROSSCHECK_MODEL) return process.env.CROSSCHECK_MODEL;
    if (process.env.ANTHROPIC_API_KEY) return "claude-haiku-4-5-20251001";
    if (process.env.GROQ_API_KEY) return "openai/gpt-oss-120b";
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "gemini-2.5-flash";
    return "none";
  },
  get concurrency() {
    loadEnv();
    return Number(process.env.CROSSCHECK_CONCURRENCY ?? 6);
  },
  /**
   * Per-minute budgets. Measured, not guessed: Groq's free tier reports
   * RPM 1000 / TPM 8000 in its response headers, and Gemini's free tier caps
   * requests at 20 per day. Override with CROSSCHECK_RPM / CROSSCHECK_TPM.
   */
  get limits() {
    loadEnv();
    const rpm = process.env.CROSSCHECK_RPM ? Number(process.env.CROSSCHECK_RPM) : null;
    const tpm = process.env.CROSSCHECK_TPM ? Number(process.env.CROSSCHECK_TPM) : null;

    if (process.env.ANTHROPIC_API_KEY) {
      return { requestsPerMinute: rpm ?? 50, tokensPerMinute: tpm ?? 200_000 };
    }
    if (process.env.GROQ_API_KEY) {
      // Sit just under the reported ceiling so a burst cannot overshoot it.
      return { requestsPerMinute: rpm ?? 200, tokensPerMinute: tpm ?? 7_000 };
    }
    return { requestsPerMinute: rpm ?? 15, tokensPerMinute: tpm ?? 100_000 };
  },
  /** True when any supported provider key is available. */
  get hasApiKey() {
    loadEnv();
    return Boolean(
      process.env.ANTHROPIC_API_KEY ||
        process.env.GROQ_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    );
  },
  get embedMode() {
    loadEnv();
    return (process.env.CROSSCHECK_EMBED ?? "ollama") as "ollama" | "off";
  },
  get embedModel() {
    loadEnv();
    return process.env.CROSSCHECK_EMBED_MODEL ?? "nomic-embed-text";
  },
  get ollamaHost() {
    loadEnv();
    return process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  },
};
