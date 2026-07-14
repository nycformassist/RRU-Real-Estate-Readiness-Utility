/**
 * api/evaluate.ts — POST /api/evaluate
 *
 * Per-phase gatekeeping for the RRU Buyer Interview (Gemini-driven).
 * Kept intentionally thin: all prompt text, phase rules, and mode logic
 * live in lib/constants.ts. This file only validates the request shape,
 * calls the model, and normalizes the response.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import {
  MODEL_NAME,
  buildEvaluateSystemInstruction,
  detectBuyerMode,
  isSupportedLanguageCode,
  DEFAULT_LANGUAGE_CODE,
  type BuyerMode,
} from "../lib/constants.js";

// ── Robust API Retry Helper ────────────────────────────────────────────────
// Silently catches 503 (busy/high demand) and 429 (rate limits) and retries 
// with exponential backoff so your users never see a 500 error screen.
async function generateWithRetry(client: GoogleGenAI, prompt: string, systemInstruction: string, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await client.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: { systemInstruction, responseMimeType: "application/json" },
      });
    } catch (error: any) {
      // Pull status/code out of nested Google error payloads if present
      const statusCode = error.status || error.code || error.statusCode || error.error?.code;
      const errorMessage = error.message ? String(error.message) : "";
      
      const isTransientError =
        statusCode === 503 ||
        statusCode === 429 ||
        errorMessage.includes("503") ||
        errorMessage.includes("UNAVAILABLE") ||
        errorMessage.includes("429");

      if (isTransientError && i < retries - 1) {
        const waitTime = Math.pow(2, i) * 1000; // 1s, then 2s, then 4s...
        console.warn(`[API] Google busy (503/429). Retrying in ${waitTime / 1000}s... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      throw error; // Throw standard validation or fatal errors
    }
  }
}

// ── SDK client — instantiated once at module scope ─────────────────────────
let ai: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return ai;
}

interface EvaluateRequestBody {
  phase: number | string;
  question: string;
  answer: string;
  allAnswers?: Record<string, unknown>;
  /**
   * BCP-47 language code. Send this once the client has picked a language
   * (or once a prior /api/evaluate response returned "detectedLanguage")
   * so every subsequent turn stays pinned to that language instead of
   * re-detecting from scratch each time.
   */
  language?: string;
}

interface EvaluateResult {
  isValid: boolean;
  extractedData: string | null;
  agentResponse: string;
  advancePhase: boolean;
  inconsistencyDetected: boolean;
  followUpTriggered: boolean;
  /** BCP-47 code — persist this and send it back as `language` on the next call. */
  detectedLanguage: string;
  languageSwitchDetected: boolean;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let client: GoogleGenAI;
  try {
    client = getClient();
  } catch {
    console.error("[api/evaluate] FATAL: GEMINI_API_KEY is not set");
    res.status(500).json({ error: "Server misconfiguration: missing GEMINI_API_KEY" });
    return;
  }

  const { phase, question, answer, allAnswers, language } = (req.body || {}) as EvaluateRequestBody;

  if (!phase || !question || answer === undefined || answer === null) {
    res.status(400).json({ error: "Missing required fields: phase, question, answer" });
    return;
  }

  const phaseNum = Number(phase);
  if (isNaN(phaseNum) || phaseNum < 1 || phaseNum > 10) {
    res.status(400).json({ error: "Invalid phase number" });
    return;
  }

  const goalAnswer = String((allAnswers as Record<string, unknown> | undefined)?.buyingGoal || "");
  const mode: BuyerMode = detectBuyerMode(goalAnswer);

  const persistedLanguage = String((allAnswers as Record<string, unknown> | undefined)?.preferredLanguage || "");
  const pinnedLanguage = isSupportedLanguageCode(language)
    ? language
    : isSupportedLanguageCode(persistedLanguage)
      ? persistedLanguage
      : undefined;

  const systemInstruction = buildEvaluateSystemInstruction(phaseNum, mode, pinnedLanguage);

  const currentDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const prompt = `Today's date: ${currentDate}.

Phase: ${phaseNum}
Question: "${question}"
Client Answer: "${String(answer).trim()}"
Previously Collected: ${JSON.stringify(allAnswers || {})}

Evaluate against the Phase ${phaseNum} rule, run the consistency check against Previously Collected, and run the dynamic follow-up check. Return your JSON response.`;

  try {
    // Call our robust retry wrapper instead of the raw client model directly
    const response = await generateWithRetry(client, prompt, systemInstruction);

    // Safeguard against undefined responses
    if (!response) {
      throw new Error("No response returned from Gemini");
    }

    const responseText = (response.text || "{}").trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[api/evaluate] Malformed model response:", responseText);
      res.status(500).json({ error: "RRU returned a malformed response" });
      return;
    }

    const result: EvaluateResult = {
      isValid: Boolean(parsed.isValid),
      extractedData: typeof parsed.extractedData === "string" ? parsed.extractedData : null,
      agentResponse:
        typeof parsed.agentResponse === "string" && parsed.agentResponse.trim().length > 0
          ? parsed.agentResponse.trim()
          : "Thanks — could you share a bit more so we can move forward?",
      advancePhase:
        Boolean(parsed.advancePhase) &&
        Boolean(parsed.isValid) &&
        parsed.extractedData !== null &&
        typeof parsed.extractedData === "string" &&
        (parsed.extractedData as string).trim().length > 0,
      inconsistencyDetected: Boolean(parsed.inconsistencyDetected),
      followUpTriggered: Boolean(parsed.followUpTriggered),
      detectedLanguage: isSupportedLanguageCode(parsed.detectedLanguage as string)
        ? (parsed.detectedLanguage as string)
        : (pinnedLanguage || DEFAULT_LANGUAGE_CODE),
      languageSwitchDetected: Boolean(parsed.languageSwitchDetected),
    };

    res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/evaluate] Evaluation error:", message);
    res.status(500).json({ error: "Failed to evaluate input", detail: message });
  }
}
