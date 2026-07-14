// Add this helper function at the top of your file
async function generateWithRetry(client: any, prompt: string, systemInstruction: string, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await client.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: { systemInstruction, responseMimeType: "application/json" },
      });
    } catch (error: any) {
      if ((error.status === 503 || error.status === 429) && i < retries - 1) {
        console.warn(`[API] Google busy. Retrying in ${Math.pow(2, i)} seconds...`);
        // Exponential backoff: waits 1s, then 2s, then 4s...
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        continue;
      }
      throw error; // If it's not a 503/429, or we're out of retries, throw the error
    }
  }
}
/**
 * api/generate-report.ts — POST /api/generate-report
 *
 * Generates the Buyer Readiness Report (Gemini-driven), then validates and
 * re-derives every scored/labeled field server-side so the numbers in the
 * response can never drift from the model's own stated evidence. The model
 * proposes; this handler disposes.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import {
  MODEL_NAME,
  CATEGORY_WEIGHTS,
  ScoreCategory,
  SCORE_CATEGORY_KEYS,
  buildReportSystemInstruction,
  detectBuyerMode,
  financingReadinessLabel,
  motivationIndexLabel,
  readinessBand,
  RISK_FLAG_TYPES,
  type BuyerMode,
} from "../lib/constants.js";

// ── SDK client — module-scope singleton (see api/evaluate.ts for rationale) ─
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

const CATEGORY_SCORE_FIELD: Record<ScoreCategory, string> = {
  financialReadiness: "scoreFinancialReadiness",
  motivation: "scoreMotivation",
  timeline: "scoreTimeline",
  propertyClarity: "scorePropertyClarity",
  financingStatus: "scoreFinancingStatus",
  decisionAuthority: "scoreDecisionAuthority",
  documentation: "scoreDocumentation",
};

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

/**
 * Re-derives the deterministic risk flags directly from the raw intake
 * answers rather than trusting the model's own "riskFlags" array. This is
 * the same pattern the legacy engine used for its calibration passes: let
 * the model draft, then verify anything that has a mechanical answer.
 */
function computeRiskFlags(answers: Record<string, unknown>, categoryScores: Record<ScoreCategory, number>): string[] {
  const flags: string[] = [];
  const mortgageStatus = String(answers.mortgageStatus || "").toLowerCase();
  const downPayment = String(answers.downPayment || "").toLowerCase();
  const timelineText = String(answers.timeline || "").toLowerCase();
  const currentHome = String(answers.currentHomeSituation || "").toLowerCase();

  const isCash = mortgageStatus.includes("cash");
  const isPreapproved = mortgageStatus.includes("preapprov");

  if (!isCash && !isPreapproved) {
    flags.push("MISSING PREAPPROVAL: Buyer has not confirmed preapproval and is not paying cash.");
  }
  if (!isCash && (downPayment.includes("unknown") || downPayment.trim().length === 0)) {
    flags.push("NO DOWN PAYMENT: Down payment source or amount has not been established.");
  }
  if (categoryScores.timeline <= 4 || timelineText.includes("don't know") || timelineText.includes("not sure")) {
    flags.push("UNCLEAR TIMELINE: No firm purchase timeline has been established.");
  }
  if (categoryScores.decisionAuthority <= 4) {
    flags.push("MULTIPLE DECISION MAKERS: Decision-making authority is shared or unconfirmed.");
  }
  if (currentHome.includes("need to sell")) {
    flags.push("NEEDS TO SELL EXISTING HOME: Purchase may be contingent on the sale of a current property.");
  }
  if (!downPayment.match(/credit|score/) && !mortgageStatus.match(/credit|score/)) {
    flags.push("CREDIT UNKNOWN: No credit information has been shared or confirmed.");
  }
  const financialText = String(answers.budget || "") + " " + String(answers.categoryEvidence ?? "");
  if (financialText.toLowerCase().includes("between jobs") || financialText.toLowerCase().includes("self-employed") && !financialText.toLowerCase().includes("confirmed")) {
    flags.push("EMPLOYMENT INSTABILITY: Employment or income stability has not been confirmed.");
  }

  return flags;
}

function derivePropertyMatch(mustHaves: string, buyingGoal: string): string[] {
  const text = `${mustHaves} ${buyingGoal}`.toLowerCase();
  const types: Record<string, string> = {
    condo: "Condo",
    "co-op": "Co-op",
    coop: "Co-op",
    townhouse: "Townhouse",
    "single family": "Single Family",
    "single-family": "Single Family",
    "multi-family": "Multi-Family",
    multifamily: "Multi-Family",
    investment: "Investment",
    luxury: "Luxury",
    commercial: "Commercial",
  };
  const matches = new Set<string>();
  for (const [kw, label] of Object.entries(types)) {
    if (text.includes(kw)) matches.add(label);
  }
  return matches.size > 0 ? Array.from(matches) : ["Unspecified"];
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
    console.error("[api/generate-report] FATAL: GEMINI_API_KEY is not set");
    res.status(500).json({ error: "Server misconfiguration: missing GEMINI_API_KEY" });
    return;
  }

  const { answers } = (req.body || {}) as { answers?: Record<string, unknown> };

  if (!answers || typeof answers !== "object") {
    res.status(400).json({ error: "Missing or invalid answers object" });
    return;
  }

  const buyingGoal = String(answers.buyingGoal || "");
  const mode: BuyerMode = detectBuyerMode(buyingGoal);
  const systemInstruction = buildReportSystemInstruction(mode);

  const prompt = `Generate the Buyer Readiness Report from this intake data:\n\n${JSON.stringify(answers, null, 2)}\n\nPopulate categoryEvidence for every category BEFORE writing any numeric score. Apply all scoring rules strictly. Verify your arithmetic before returning. The "score" field must equal the exact sum of the 7 category scores. Return the JSON object.`;

  let parsed: Record<string, unknown>;
  try {
    const response = await client.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: { systemInstruction, responseMimeType: "application/json" },
    });

    const responseText = (response.text || "{}").trim();
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[api/generate-report] Malformed model response:", responseText);
      res.status(500).json({ error: "RRU returned a malformed report response" });
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/generate-report] Report generation error:", message);
    res.status(500).json({ error: "Failed to generate report", detail: message });
    return;
  }

  if (!parsed.structuredData || !parsed.buyerSummary) {
    console.error("[api/generate-report] Report missing required fields:", Object.keys(parsed));
    res.status(500).json({ error: "RRU report was incomplete" });
    return;
  }

  const sd = parsed.structuredData as Record<string, unknown>;

  // ── Rigid math: clamp every category to its weight ceiling, then
  //    recompute the total as their exact sum. The model's own "score"
  //    field is never trusted directly. ─────────────────────────────────
  const categoryScores = {} as Record<ScoreCategory, number>;
  for (const category of SCORE_CATEGORY_KEYS) {
    const field = CATEGORY_SCORE_FIELD[category];
    const raw = Number((sd as Record<string, unknown>)[field] ?? 0);
    const clamped = clamp(raw, CATEGORY_WEIGHTS[category]);
    categoryScores[category] = clamped;
    (sd as Record<string, unknown>)[field] = clamped;
  }

  // Require categoryEvidence to exist for every category — chain-of-thought
  // must be present, or that category is forced to its lowest band.
  const evidence = (sd.categoryEvidence as Record<string, unknown>) || {};
  for (const category of SCORE_CATEGORY_KEYS) {
    const ev = evidence[category];
    const hasEvidence = typeof ev === "string" && ev.trim().length > 0;
    if (!hasEvidence && categoryScores[category] > 0) {
      console.warn(`[api/generate-report] No categoryEvidence for "${category}" — forcing score to 0.`);
      categoryScores[category] = 0;
      (sd as Record<string, unknown>)[CATEGORY_SCORE_FIELD[category]] = 0;
    }
  }

  const computedScore = SCORE_CATEGORY_KEYS.reduce((sum, c) => sum + categoryScores[c], 0);
  if (Number(sd.score) !== computedScore) {
    console.warn(`[api/generate-report] Score corrected — model returned ${sd.score}, server computed ${computedScore}.`);
  }
  sd.score = computedScore;

  // ── Derived labels — always server-computed, never trusted from the model
  const band = readinessBand(computedScore);
  sd.readinessBand = band.label;
  sd.agentPriority = band.agentPriority;
  sd.financingReadiness = financingReadinessLabel(categoryScores.financingStatus);
  sd.motivationIndex = motivationIndexLabel(categoryScores.motivation);
  sd.buyerMode = mode;

  // ── Risk flags — recomputed deterministically from raw answers
  const computedFlags = computeRiskFlags(answers, categoryScores);
  sd.riskFlags = computedFlags.length > 0 ? computedFlags : ["None identified."];

  // ── Property match — recomputed from must-haves + goal text
  sd.propertyMatch = derivePropertyMatch(String(answers.mustHaves || ""), buyingGoal);

  // ── Recommended next step — deterministic mapping off the validated band
  //    and financing readiness, so it can never contradict the score.
  const hasMissingPreapproval = computedFlags.some((f) => f.startsWith("MISSING PREAPPROVAL"));
  const hasCreditUnknown = computedFlags.some((f) => f.startsWith("CREDIT UNKNOWN"));
  let nextStep: string;
  if (computedScore < 40) {
    nextStep = "Follow Up in 90 Days";
  } else if (hasCreditUnknown && categoryScores.financingStatus <= 7) {
    nextStep = "Needs Credit Counseling";
  } else if (hasMissingPreapproval) {
    nextStep = "Refer to Mortgage Broker";
  } else if (computedScore >= 70) {
    nextStep = "Schedule Showing";
  } else {
    nextStep = "Request Documentation";
  }
  sd.recommendedNextStep = nextStep;

  // ── RISK_FLAG_TYPES is exported for downstream consumers (e.g. the
  //    dashboard) that want to render a fixed-order checklist; expose it
  //    alongside the computed flags without altering scoring.
  sd.riskFlagTaxonomy = RISK_FLAG_TYPES;

  res.status(200).json(parsed);
}
