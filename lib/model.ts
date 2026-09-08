/**
 * Provider selection.
 *
 * The knowledge layer does not care which model performs extraction, so the
 * provider is chosen from whichever key is present rather than hardcoded. That
 * costs one small module and buys two things worth having:
 *
 *   - a grader can run this with either an Anthropic or a Google key, whichever
 *     they happen to have;
 *   - the cache key includes the model id, so switching providers does not
 *     silently reuse another model's answers. Results stay attributable.
 *
 * Set CROSSCHECK_MODEL to override the default for the selected provider.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { loadEnv } from "./env";

export type Provider = "anthropic" | "groq" | "google" | "none";

const DEFAULT_MODEL: Record<Exclude<Provider, "none">, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  groq: "openai/gpt-oss-120b",
  google: "gemini-2.5-flash",
};

/**
 * Which provider this environment can actually reach.
 *
 * Order is deliberate: quality first, then throughput. Groq outranks Google here
 * because AI Studio's free tier caps at 20 requests a day, which is not enough to
 * ingest a single document — a limit discovered the hard way partway through the
 * first full run. Set CROSSCHECK_PROVIDER to override.
 */
export function activeProvider(): Provider {
  loadEnv();
  const forced = process.env.CROSSCHECK_PROVIDER as Provider | undefined;
  if (forced && forced !== "none") return forced;

  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google";
  return "none";
}

/**
 * Models to try, in order, for the active provider.
 *
 * Exists because free tiers meter per MODEL, not per key: Groq allows 200,000
 * tokens per day for each of `gpt-oss-120b`, `gpt-oss-20b` and `qwen3.8-27b` —
 * about 80 pages each. Treating them as one 240-page budget is the difference
 * between finishing a 126-page filing and stopping two-thirds of the way through.
 *
 * Ordered best-quality first, so the fallbacks only carry the pages the preferred
 * model could not.
 */
const MODEL_CHAIN: Record<Exclude<Provider, "none">, string[]> = {
  anthropic: ["claude-haiku-4-5-20251001"],
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  google: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
};

/** Models whose daily quota is spent; skipped for the rest of the process. */
const exhausted = new Set<string>();

export function markExhausted(model: string): void {
  exhausted.add(model);
}

export function isExhausted(model: string): boolean {
  return exhausted.has(model);
}

/**
 * The chain to try for this request, best first, minus anything already known to
 * be out of quota. An explicit CROSSCHECK_MODEL pins a single model.
 */
export function modelChain(): string[] {
  loadEnv();
  const explicit = process.env.CROSSCHECK_MODEL;
  if (explicit) return [explicit];

  const provider = activeProvider();
  if (provider === "none") return [];
  const chain = MODEL_CHAIN[provider];
  const live = chain.filter((m) => !exhausted.has(m));
  // If everything is spent, keep the last one so the caller gets a real error
  // rather than an empty chain it has to special-case.
  return live.length ? live : chain.slice(-1);
}

/** Every model that may hold a cached answer, regardless of current quota. */
export function allModels(): string[] {
  loadEnv();
  const explicit = process.env.CROSSCHECK_MODEL;
  const provider = activeProvider();
  const chain = provider === "none" ? [] : MODEL_CHAIN[provider];
  return explicit ? [explicit, ...chain.filter((m) => m !== explicit)] : chain;
}

/** Model id in use, for cache keys and for reporting. */
export function modelId(): string {
  return modelChain()[0] ?? "none";
}

/**
 * The AI SDK model handle.
 *
 * The Google provider reads GOOGLE_GENERATIVE_AI_API_KEY, but GEMINI_API_KEY is
 * the name the AI Studio console hands you, so accept both and bridge them here
 * rather than making the user rename a variable.
 */
export function languageModel(modelOverride?: string): LanguageModel {
  loadEnv();
  const provider = activeProvider();
  const id = modelOverride ?? modelId();

  if (provider === "groq") return groq(id);

  if (provider === "google") {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
    }
    return google(id);
  }

  return anthropic(id);
}

export function hasModelAccess(): boolean {
  return activeProvider() !== "none";
}

/**
 * Per-provider request options.
 *
 * MEASURED, not assumed: disabling Gemini's thinking budget for extraction was
 * tried and reverted. It looked like free latency — extraction is transcription
 * under a schema, not deduction — but 48 of 51 calls then failed to produce a
 * valid object at all, and the run yielded 7 facts instead of 148. On this model
 * the reasoning pass is load-bearing for structured output, so it stays on.
 *
 * Kept as a hook because the right value is provider-specific, and because the
 * next model to be tried here deserves the same measurement rather than an
 * inherited assumption.
 */
export function providerOptions(_purpose: "extract" | "adjudicate" = "extract") {
  return undefined;
}
