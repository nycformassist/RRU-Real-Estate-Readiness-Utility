/**
 * api/evaluate.ts — POST /api/evaluate
 *
 * Per-phase gatekeeping for the RRU Buyer Interview (Gemini-driven).
 * Kept intentionally thin: all prompt text, phase rules, and mode logic
 * live in lib/constants.ts; all model-calling/retry logic lives in
 * lib/gemini-client.ts. This file validates the request shape, calls
 * generateJSON(), and — critically — recomputes "advancePhase" itself
 * rather than trusting the model's own value for it. See the "STATE
 * DESYNC FIX" block below for why.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildEvaluateSystemInstruction,
  detectBuyerMode,
  isSupportedLanguageCode,
  DEFAULT_LANGUAGE_CODE,
  EVALUATE_RESPONSE_SCHEMA,
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

/**
 * Coerces "boolean-ish" values (real booleans, and the string forms a
 * model or a lossy JSON round-trip might produce) to a real boolean.
 * `EVALUATE_RESPONSE_SCHEMA` should make the string cases impossible in
 * practice, but this stays as a second line of defense — cheap insurance
 * against any client (or a future prompt change) that stops using the
 * schema.
 */
function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
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
  if (isNaN(phaseNum) || phaseNum < 1 || phaseNum > 11) {
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
    const responseText = await generateJSON(systemInstruction, prompt, EVALUATE_RESPONSE_SCHEMA);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[api/evaluate] Malformed model response:", responseText);
      res.status(500).json({ error: "RRU returned a malformed response" });
      return;
    }

    const isValid = toBool(parsed.isValid);
    const extractedData = typeof parsed.extractedData === "string" ? parsed.extractedData.trim() : "";
    const hasExtractedData = extractedData.length > 0;
    const inconsistencyDetected = toBool(parsed.inconsistencyDetected);
    const followUpTriggered = toBool(parsed.followUpTriggered);
    const modelAdvancePhase = toBool(parsed.advancePhase);

    // ── STATE DESYNC FIX ────────────────────────────────────────────────
    // advancePhase is now COMPUTED here, not trusted directly from the
    // model's own field. The two legitimate reasons to hold the phase are
    // exactly `inconsistencyDetected` and `followUpTriggered` (both are
    // themselves separately validated flags, not free-form claims) — see
    // the ADVANCE-PHASE RULE in lib/constants.ts. If isValid is true,
    // there's real extractedData, and neither hold-back flag is set, the
    // phase advances regardless of what the model wrote for advancePhase
    // itself. This is what actually fixes the desync: previously, if the
    // model's conversational agentResponse moved on to the next question
    // but it forgot (or mis-set) advancePhase, the UI would silently
    // stall on the old phase while the model had already moved on. Now
    // the flag it might get wrong is no longer load-bearing.
    //
    // modelAdvancePhase is still consulted as an OR: if the model
    // explicitly says advance (e.g. for a phase rule nuance not captured
    // by isValid/extractedData alone) that's honored too — this can only
    // ever advance MORE readily than before, never get stuck worse.
    const advancePhase =
      modelAdvancePhase ||
      (isValid && hasExtractedData && !inconsistencyDetected && !followUpTriggered);

    if (modelAdvancePhase !== advancePhase) {
      console.warn(
        `[api/evaluate] Corrected advancePhase: model said ${modelAdvancePhase}, server computed ${advancePhase} ` +
          `(isValid=${isValid}, hasExtractedData=${hasExtractedData}, inconsistencyDetected=${inconsistencyDetected}, followUpTriggered=${followUpTriggered}).`
      );
    }

    const result: EvaluateResult = {
      isValid,
      extractedData: hasExtractedData ? extractedData : null,
      agentResponse:
        typeof parsed.agentResponse === "string" && parsed.agentResponse.trim().length > 0
          ? parsed.agentResponse.trim()
          : "Thanks — could you share a bit more so we can move forward?",
      advancePhase,
      inconsistencyDetected,
      followUpTriggered,
      detectedLanguage: isSupportedLanguageCode(parsed.detectedLanguage as string)
        ? (parsed.detectedLanguage as string)
        : (pinnedLanguage || DEFAULT_LANGUAGE_CODE),
      languageSwitchDetected: toBool(parsed.languageSwitchDetected),
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