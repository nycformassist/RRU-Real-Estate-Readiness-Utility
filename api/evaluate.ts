/**
 * api/evaluate.ts — POST /api/evaluate
 *
 * Per-phase gatekeeping for the RRU Buyer Interview (Gemini-driven).
 * Kept intentionally thin: all prompt text, phase rules, and mode logic
 * live in lib/constants.ts. This file only validates the request shape,
 * calls the model, and normalizes the response.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildEvaluateSystemInstruction,
  detectBuyerMode,
  isSupportedLanguageCode,
  DEFAULT_LANGUAGE_CODE,
  type BuyerMode,
} from "../lib/constants.js";
import { generateJSON, UpstreamUnavailableError } from "../lib/gemini-client.js";

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

  // Prefer an explicit `language` on this request; fall back to a language
  // already persisted on allAnswers from a prior turn; otherwise leave
  // undefined so the model auto-detects from the client's raw answer.
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
    const responseText = await generateJSON(systemInstruction, prompt);

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
    if (err instanceof UpstreamUnavailableError) {
      console.error("[api/evaluate] Upstream unavailable:", err.message);
      res.status(503).json({
        error: "RRU is temporarily busy — please try again in a few seconds.",
        retryable: true,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/evaluate] Evaluation error:", message);
    res.status(500).json({ error: "Failed to evaluate input", detail: message });
  }
}
