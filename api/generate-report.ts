/**
 * api/generate-report.ts — POST /api/generate-report
 *
 * Generates the Buyer Readiness Report (Gemini-driven), then validates and
 * re-derives every scored/labeled field server-side so the numbers in the
 * response can never drift from the model's own stated evidence. The model
 * proposes; this handler disposes. Model-calling/retry logic lives in
 * lib/gemini-client.ts.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  CATEGORY_WEIGHTS,
  ScoreCategory,
  SCORE_CATEGORY_KEYS,
  buildReportSystemInstruction,
  detectBuyerMode,
  financingReadinessLabel,
  motivationIndexLabel,
  readinessBand,
  buildFullBuyerReport,
  RISK_FLAG_TYPES,
  VERIFICATION_ITEM_TYPES,
  languageByCode,
  isSupportedLanguageCode,
  type BuyerMode,
} from "../lib/constants.js";
import { generateJSON, UpstreamUnavailableError } from "../lib/gemini-client.js";

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
 * Re-derives deterministic risk flags AND neutral verification items directly 
 * from the raw intake answers. This prevents the model from hallucinating 
 * generic risks (like "Missing Preapproval") when the data explicitly resolves them.
 */
function computeRiskAndVerification(
  answers: Record<string, unknown>, 
  categoryScores: Record<ScoreCategory, number>
): { riskFlags: string[]; verificationItems: string[] } {
  const riskFlags: string[] = [];
  const verificationItems: string[] = [];

  // Combine financing fields to catch "Pre-approved" regardless of which key it landed in
  const rawFinancingText = `${answers.financing || ""} ${answers.mortgageStatus || ""}`.toLowerCase();
  
  // FIX HYPHEN BUG: Remove hyphens so "pre-approved" successfully matches "preapprov"
  const financingText = rawFinancingText.replace(/-/g, "");
  const downPayment = String(answers.downPayment || "").toLowerCase();
  const timelineText = String(answers.timeline || "").toLowerCase();
  const currentHome = String(answers.currentHomeSituation || "").toLowerCase();
  const obstacles = String(answers.obstacles || "").toLowerCase();

  const isCash = financingText.includes("cash");
  const isPreapproved = financingText.includes("preapprov") || financingText.includes("prequalif");

  // 1. MISSING PREAPPROVAL (Strict: only if NOT cash AND NOT preapproved)
  if (!isCash && !isPreapproved) {
    riskFlags.push("MISSING PREAPPROVAL: Buyer has not confirmed preapproval and is not paying cash.");
  }

  // 2. NO DOWN PAYMENT
  if (!isCash && (downPayment.includes("unknown") || downPayment.trim().length === 0)) {
    riskFlags.push("NO DOWN PAYMENT: Down payment source or amount has not been established.");
  }

  // 3. UNCLEAR TIMELINE
  // Hard guardrail: If ANY specific timeline text is provided (and isn't explicitly "don't know"), 
  // we hard-block the UNCLEAR TIMELINE flag, regardless of the LLM's category score.
  const hasSpecificTimeline = timelineText.length > 0 && 
                              !timelineText.includes("don't know") && 
                              !timelineText.includes("not sure") && 
                              !timelineText.includes("unknown");
  if (!hasSpecificTimeline) {
    riskFlags.push("UNCLEAR TIMELINE: No firm purchase timeline has been established.");
  }

  // 4. MULTIPLE DECISION MAKERS (Only if explicitly stated as an obstacle, NOT just because it wasn't asked)
  if (obstacles.includes("spouse") || obstacles.includes("partner") || obstacles.includes("unsure") || obstacles.includes("conflict")) {
    riskFlags.push("MULTIPLE DECISION MAKERS: Decision-making authority is shared or unconfirmed.");
  } else {
    verificationItems.push("Confirm if there are any co-buyers or additional decision-makers involved.");
  }

  // 5. NEEDS TO SELL EXISTING HOME
  if (currentHome.includes("need to sell")) {
    riskFlags.push("NEEDS TO SELL EXISTING HOME: Purchase may be contingent on the sale of a current property.");
  }

  // 6. CREDIT UNKNOWN (Only if explicitly stated as a problem, NOT just because it wasn't asked)
  const creditText = `${answers.creditScore || ""} ${answers.credit || ""} ${obstacles}`.toLowerCase();
  if (creditText.includes("bad") || creditText.includes("poor") || creditText.includes("repair") || creditText.includes("unknown")) {
    riskFlags.push("CREDIT UNKNOWN: Credit issues identified as an obstacle.");
  } else {
    verificationItems.push("Verify exact credit score and history with mortgage broker.");
  }

  // 7. EMPLOYMENT INSTABILITY
  const financialText = String(answers.budget || "") + " " + String(answers.categoryEvidence ?? "");
  if (financialText.toLowerCase().includes("between jobs") || (financialText.toLowerCase().includes("self-employed") && !financialText.toLowerCase().includes("confirmed"))) {
    riskFlags.push("EMPLOYMENT INSTABILITY: Employment or income stability has not been confirmed.");
  }

  // 8. REAL NUMERIC BUDGET-VS-PREAPPROVAL CROSS-CHECK
  const budgetStr = String(answers.budget || "");
  const financingStr = String(answers.financing || "") + " " + String(answers.mortgageStatus || "");
  
  const budgetNumbers = budgetStr.match(/\d+/g);
  const maxBudget = budgetNumbers ? Math.max(...budgetNumbers.map(Number)) : 0;
  
  const preapprovalNumbers = financingStr.match(/\d+/g);
  const preapprovalAmount = preapprovalNumbers ? Math.max(...preapprovalNumbers.map(Number)) : 0;

  if (maxBudget > 0 && preapprovalAmount > 0 && maxBudget > preapprovalAmount) {
    verificationItems.push(`Budget-to-Preapproval Gap: Stated max budget ($${maxBudget.toLocaleString()}) exceeds mentioned pre-approval amount ($${preapprovalAmount.toLocaleString()}). Agent to verify financing strategy for the difference.`);
  }

  // 9. DOCUMENTATION (Context-aware verification item)
  // Extract the raw string exactly as the user typed it to feed back into the verification prompt contextually
  const rawFinancingStr = [answers.mortgageStatus, answers.financing].filter(Boolean).join(" ").trim();
  
  if (isPreapproved) {
    verificationItems.push(`Verify and collect existing pre-approval documentation (e.g., ${rawFinancingStr}) to validate buyer capacity.`);
  } else if (isCash) {
    verificationItems.push("Verify and collect existing proof of funds documentation to validate buyer capacity.");
  } else if (!financingText.includes("proof of funds") && !financingText.includes("preapproval letter")) {
    verificationItems.push("Gather proof of funds or preapproval letter if not already provided.");
  }

  return { riskFlags, verificationItems };
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

  if (!process.env.GEMINI_API_KEY) {
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
    const responseText = await generateJSON(systemInstruction, prompt);
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[api/generate-report] Malformed model response:", responseText);
      res.status(500).json({ error: "RRU returned a malformed report response" });
      return;
    }
  } catch (err: unknown) {
    if (err instanceof UpstreamUnavailableError) {
      console.error("[api/generate-report] Upstream unavailable:", err.message);
      res.status(503).json({
        error: "RRU is temporarily busy — please try again in a few seconds.",
        retryable: true,
      });
      return;
    }
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

  // clientLanguage: trust the persisted code from the intake flow over
  // whatever the model guessed, since it's the language actually recorded
  // turn-by-turn by /api/evaluate rather than inferred after the fact.
  const persistedLanguageCode = String(answers.preferredLanguage || "");
  sd.clientLanguage = isSupportedLanguageCode(persistedLanguageCode)
    ? languageByCode(persistedLanguageCode).label
    : (typeof sd.clientLanguage === "string" && sd.clientLanguage.trim().length > 0 ? sd.clientLanguage : "English");

  // ── Risk flags & Verification Items — recomputed deterministically from raw answers
  const { riskFlags: computedFlags, verificationItems } = computeRiskAndVerification(answers, categoryScores);
  sd.riskFlags = computedFlags.length > 0 ? computedFlags : ["None identified."];
  sd.verificationItems = verificationItems;

  // ── Property match — recomputed from must-haves + goal text
  sd.propertyMatch = derivePropertyMatch(String(answers.mustHaves || ""), buyingGoal);

  // ── Recommended next step — deterministic mapping off the validated band
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

  // ── RISK_FLAG_TYPES and VERIFICATION_ITEM_TYPES are exported for downstream consumers
  sd.riskFlagTaxonomy = RISK_FLAG_TYPES;
  sd.verificationItemTaxonomy = VERIFICATION_ITEM_TYPES;

  // ── Full report assembly ────────────────────────────────────────────
  const aiNarrative =
    typeof parsed.buyerSummary === "string" && parsed.buyerSummary.trim().length > 0
      ? parsed.buyerSummary.trim()
      : "Summary unavailable — review raw intake data below.";
  sd.aiNarrative = aiNarrative;
  
  // Pass verificationItems into the report builder
  parsed.buyerSummary = buildFullBuyerReport(sd, answers, aiNarrative, verificationItems);

  res.status(200).json(parsed);
}