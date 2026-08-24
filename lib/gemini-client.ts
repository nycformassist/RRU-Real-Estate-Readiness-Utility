/**
 * lib/gemini-client.ts
 *
 * Single place that actually talks to the Gemini API. Both api/evaluate.ts
 * and api/generate-report.ts call generateJSON() instead of touching the
 * SDK directly, so retry/backoff/fallback behavior only needs to exist —
 * and be fixed — in one place.
 *
 * Handles the "This model is currently experiencing high demand" (503)
 * and rate-limit (429) responses Gemini returns during capacity spikes:
 *   1. Retry the primary model a few times with exponential backoff + jitter.
 *   2. If the primary is still unavailable, fail over once to a secondary
 *      model from a different generation.
 *   3. If both are exhausted, throw UpstreamUnavailableError so the
 *      handler can return HTTP 503 (retry-worthy) instead of a generic 500.
 */

import { GoogleGenAI } from "@google/genai";
import { MODEL_NAME, FALLBACK_MODEL_NAME } from "./constants.js";

let client: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

/** Thrown when both the primary and fallback models are unavailable after retries. */
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

const RETRYABLE_STATUS_CODES = [429, 503];
const MAX_ATTEMPTS_PER_MODEL = 3;
const BASE_DELAY_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The SDK surfaces upstream HTTP errors as an Error whose message is the
 * raw JSON body, e.g. {"error":{"code":503,"message":"...","status":"UNAVAILABLE"}}.
 * Pull the status code out of that so we can tell "busy, worth retrying"
 * apart from "bad request" or "invalid API key."
 */
function extractStatusCode(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(msg);
    const code = parsed?.error?.code;
    if (typeof code === "number") return code;
  } catch {
    // message wasn't JSON — fall through to a loose regex match
  }
  const match = msg.match(/"code"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

async function callModelWithRetry(
  modelName: string,
  systemInstruction: string,
  prompt: string,
  responseSchema?: object
) {
  const ai = getGeminiClient();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
    try {
      return await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          ...(responseSchema ? { responseSchema } : {}),
        },
      });
    } catch (err) {
      lastErr = err;
      const status = extractStatusCode(err);
      const retryable = status !== null && RETRYABLE_STATUS_CODES.includes(status);
      if (!retryable || attempt === MAX_ATTEMPTS_PER_MODEL) throw err;

      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(
        `[gemini-client] ${modelName} busy (status ${status}). Retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL})`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Generates a JSON response, with retry-with-backoff on the primary model
 * and a one-time fallback to a different model generation if the primary
 * is still unavailable after retries.
 *
 * `responseSchema`, if provided, is passed to Gemini's structured-output
 * mode (see lib/constants.ts EVALUATE_RESPONSE_SCHEMA) so the model is
 * constrained to return the exact field types requested — no strings
 * where booleans are expected, no missing required fields.
 */
export async function generateJSON(systemInstruction: string, prompt: string, responseSchema?: object): Promise<string> {
  try {
    const response = await callModelWithRetry(MODEL_NAME, systemInstruction, prompt, responseSchema);
    return (response.text || "{}").trim();
  } catch (primaryErr) {
    const status = extractStatusCode(primaryErr);
    if (status === null || !RETRYABLE_STATUS_CODES.includes(status)) {
      // Not a capacity issue (bad request, auth failure, etc.) — don't
      // mask it by trying a second model, just surface it.
      throw primaryErr;
    }

    console.warn(`[gemini-client] ${MODEL_NAME} exhausted retries — falling back to ${FALLBACK_MODEL_NAME}.`);
    try {
      const response = await callModelWithRetry(FALLBACK_MODEL_NAME, systemInstruction, prompt, responseSchema);
      return (response.text || "{}").trim();
    } catch (fallbackErr) {
      const fbStatus = extractStatusCode(fallbackErr);
      if (fbStatus !== null && RETRYABLE_STATUS_CODES.includes(fbStatus)) {
        throw new UpstreamUnavailableError(
          `Both ${MODEL_NAME} and ${FALLBACK_MODEL_NAME} are currently unavailable (Google capacity issue). Please try again shortly.`
        );
      }
      throw fallbackErr;
    }
  }
}