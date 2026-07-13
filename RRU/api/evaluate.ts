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
import { MODEL_NAME, buildEvaluateSystemInstruction, detectBuyerMode, type BuyerMode } from "../lib/constants.js";

// ── SDK client — instantiated once at module scope ─────────────────────────
// Vercel reuses warm containers between invocations, so constructing the
// client here (instead of inside the handler) avoids re-creating it on
// every request and shaves latency off cold starts that DO occur.
// The API key is only read here, not validated — validation happens inside
// the handler so a missing key returns a proper HTTP error instead of
// crashing the function at import time (which Vercel would surface as an
// opaque 500 with no body).
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
}

interface EvaluateResult {
  isValid: boolean;
  extractedData: string | null;
  agentResponse: string;
  advancePhase: boolean;
  inconsistencyDetected: boolean;
  followUpTriggered: boolean;
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

  const { phase, question, answer, allAnswers } = (req.body || {}) as EvaluateRequestBody;

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

  const systemInstruction = buildEvaluateSystemInstruction(phaseNum, mode);

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
    const response = await client.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: { systemInstruction, responseMimeType: "application/json" },
    });

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
    };

    res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/evaluate] Evaluation error:", message);
    res.status(500).json({ error: "Failed to evaluate input", detail: message });
  }
}
