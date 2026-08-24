/**
 * lib/constants.ts
 *
 * Single source of truth for the RRU (Real Estate Readiness Utility) engine.
 * Every shared prompt, phase rule, scoring weight, and system-instruction
 * builder lives here so that api/evaluate.ts and api/generate-report.ts
 * stay thin, stateless, and fast to cold-start.
 *
 * Nothing in this file performs I/O. It is pure data + pure functions,
 * which means it can be imported into either serverless function (or a
 * unit test) with zero side effects.
 */

// ─────────────────────────────────────────────────────────────────────────
// Model config
// ─────────────────────────────────────────────────────────────────────────
export const MODEL_NAME = "gemini-3.5-flash";
export const FALLBACK_MODEL_NAME = "gemini-2.5-flash";

// ─────────────────────────────────────────────────────────────────────────
// Strict response schema for /api/evaluate
// ─────────────────────────────────────────────────────────────────────────
export const EVALUATE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    isValid: { type: "BOOLEAN" },
    extractedData: { type: "STRING", nullable: true },
    agentResponse: { type: "STRING" },
    advancePhase: { type: "BOOLEAN" },
    inconsistencyDetected: { type: "BOOLEAN" },
    followUpTriggered: { type: "BOOLEAN" },
    detectedLanguage: { type: "STRING" },
    languageSwitchDetected: { type: "BOOLEAN" },
  },
  required: [
    "isValid",
    "extractedData",
    "agentResponse",
    "advancePhase",
    "inconsistencyDetected",
    "followUpTriggered",
    "detectedLanguage",
    "languageSwitchDetected",
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Language access — NYC Local Law 30 (2017) designated citywide languages
// ─────────────────────────────────────────────────────────────────────────

export interface SupportedLanguage {
  code: string;
  label: string;
  nativeLabel: string;
  rtl?: boolean;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "zh", label: "Chinese", nativeLabel: "中文" },
  { code: "ru", label: "Russian", nativeLabel: "Русский" },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা" },
  { code: "ht", label: "Haitian Creole", nativeLabel: "Kreyòl Ayisyen" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", rtl: true },
  { code: "ur", label: "Urdu", nativeLabel: "اردو", rtl: true },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "pl", label: "Polish", nativeLabel: "Polski" },
];

export const DEFAULT_LANGUAGE_CODE = "en";

export function isSupportedLanguageCode(code: string | undefined | null): code is string {
  return !!code && SUPPORTED_LANGUAGES.some((l) => l.code === code);
}

export function languageByCode(code: string | undefined | null): SupportedLanguage {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code) || SUPPORTED_LANGUAGES[0];
}

export function buildLanguageDirective(explicitCode?: string | null): string {
  if (explicitCode && isSupportedLanguageCode(explicitCode)) {
    const lang = languageByCode(explicitCode);
    if (lang.code === "en") {
      return `\nLANGUAGE: Respond in English. Set "detectedLanguage" to "en".`;
    }
    return `
─────────────────────────────────────────
LANGUAGE
─────────────────────────────────────────
The client's language is ${lang.label} (${lang.nativeLabel}). Write "agentResponse" entirely in ${lang.label}, using natural, warm, native-level phrasing — not a literal translation of the English phase script. Numbers, dollar amounts, and proper nouns (names, neighborhoods, lender names) stay as given.
Do NOT translate JSON keys or any fixed enum value (e.g. "isValid", "advancePhase", language codes) — those stay in English exactly as specified so downstream code can parse them.
If the client's current answer is written in a different language than ${lang.label}, mirror the language the client just used for this turn's agentResponse, set "detectedLanguage" to that language's code instead, and set "languageSwitchDetected" to true.
Otherwise set "detectedLanguage" to "${lang.code}" and "languageSwitchDetected" to false.`;
  }

  return `
─────────────────────────────────────────
LANGUAGE (auto-detect — no language has been set yet)
─────────────────────────────────────────
Detect the language of the client's current answer. Supported first-class languages and their codes: ${SUPPORTED_LANGUAGES.map((l) => `${l.label}=${l.code}`).join(", ")}. If the answer is in a language outside this list, still detect it and use its correct BCP-47 code.
Write "agentResponse" in the SAME language the client just used. Set "detectedLanguage" to that language's code and "languageSwitchDetected" to false.
If the answer is too short to confidently detect a language (e.g. just a phone number), default to English and set "detectedLanguage" to "en".`;
}

// ─────────────────────────────────────────────────────────────────────────
// Buyer mode detection (mirrors the old PI/GENERAL split, adapted for RE)
// ─────────────────────────────────────────────────────────────────────────

export type BuyerMode = "STANDARD" | "INVESTOR" | "COMMERCIAL";

const INVESTOR_KEYWORDS = [
  "invest", "investment", "rental", "cap rate", "cash flow", "roi",
  "flip", "flipping", "portfolio", "multi-family", "multifamily",
  "buy and hold", "airbnb", "short-term rental", "str",
];

const COMMERCIAL_KEYWORDS = [
  "commercial", "retail space", "office space", "warehouse", "mixed-use",
  "storefront", "industrial", "lease space",
];

export function detectBuyerMode(goalAnswer: string): BuyerMode {
  const text = (goalAnswer || "").toLowerCase();
  if (COMMERCIAL_KEYWORDS.some((kw) => text.includes(kw))) return "COMMERCIAL";
  if (INVESTOR_KEYWORDS.some((kw) => text.includes(kw))) return "INVESTOR";
  return "STANDARD";
}

// ─────────────────────────────────────────────────────────────────────────
// Phase rules — Aligned precisely 1:1 with the 10 App.tsx phases
// ─────────────────────────────────────────────────────────────────────────

export const PHASE_RULES: Record<number, string> = {
  1: `PHASE 1 — FULL NAME:
ACCEPT: A plausible first name at minimum.
REJECT: Placeholder text ("Test", "N/A", "Anonymous"), gibberish.
extractedData: The trimmed name exactly as provided.`,

  2: `PHASE 2 — CONTACT INFO:
ACCEPT: A valid-looking email address (x@x.x format) OR a phone number (at least 7 digits).
REJECT: A response with no usable contact method.
extractedData: The trimmed contact details exactly as provided.`,

  3: `PHASE 3 — BUYING GOAL:
ACCEPT: A clear selection or description of intent: Buying, Selling, Investing, Relocating, Second Home, or Commercial. "I'm just looking" is a VALID answer for this phase — do not reject it, route it through the "just looking" pushback below instead.
REJECT: Only reject if the response is completely unrelated to real estate intent.
PUSHBACK ("I'm just looking."): Respond warmly, not defensively. Acknowledge that many buyers begin exploring months before deciding.
extractedData: The trimmed goal exactly as provided, or "Exploring / just looking".`,

  4: `PHASE 4 — LOCATION:
ACCEPT: At least one concrete locational anchor: a city, neighborhood, ZIP code, school district, or commute constraint.
REJECT: Only reject a flat "I don't know" with zero follow-up engagement.
PUSHBACK ("I don't know."): Offer a short menu instead of pressing for a place name — ask whether they're prioritizing lowest price, best schools, easy commute, etc.
extractedData: The trimmed location detail(s) or priority selected.`,

  5: `PHASE 5 — BUDGET:
ACCEPT: A target price, a maximum price, or a stated intent to pay cash — even an approximate range is sufficient.
REJECT: Only reject a flat non-answer with no range implied at all.
PUSHBACK ("I'm not sure."): Reassure the client this is common, offer a broad bracket.
extractedData: The trimmed budget detail exactly as provided.`,

  6: `PHASE 6 — MORTGAGE STATUS:
ACCEPT: Any clear statement of financing status: preapproved, not yet preapproved, cash buyer, or loan type preference.
REJECT: Only reject a non-answer that provides no financing signal whatsoever.
PUSHBACK ("I haven't talked to anyone."): Reassure the client — many buyers research properties before speaking with a lender.
extractedData: The trimmed financing status exactly as provided.`,

  7: `PHASE 7 — DOWN PAYMENT:
ACCEPT: A percentage (5%, 10%, 20%), a source (gift, grant, savings), or an explicit "unknown."
REJECT: Only reject a refusal to engage with the topic at all.
PUSHBACK ("I'd rather not say."): Acknowledge this is completely understandable. Accept "prefer not to say" as valid extractedData.
extractedData: The trimmed down payment detail exactly as provided.`,

  8: `PHASE 8 — TIMELINE:
ACCEPT: Any of: Immediately, 30 Days, 60 Days, 90 Days, 6 Months, Next Year, or a comparable free-text estimate.
REJECT: Only reject a flat "I don't know" with no engagement on the follow-up.
PUSHBACK ("I don't know."): Ask a concrete hypothetical instead of pressing for a date.
extractedData: The trimmed timeline exactly as provided.`,

  9: `PHASE 9 — MUST-HAVES:
ACCEPT: Any concrete preference(s): bedrooms, bathrooms, garage, yard, school district, transit access, parking, HOA tolerance, pool, accessibility needs, or property type.
REJECT: Only reject a total non-answer.
extractedData: The trimmed list of must-haves exactly as provided.`,

  10: `PHASE 10 — OBSTACLES:
ACCEPT: Any substantive response naming the biggest obstacle (saving, credit, finding the right property, interest rates, needing to sell first) — or an explicit "nothing standing in my way."
REJECT: Blank, a single character, or clearly nonsensical input.
PUSHBACK ("I'm just browsing."): Acknowledge that many successful buyers start by exploring the market before they're ready to purchase.
extractedData: The trimmed obstacle description exactly as provided, or "None identified".`,
};

// ─────────────────────────────────────────────────────────────────────────
// Mode-specific addenda (Mapped to the updated 1-10 numbering)
// ─────────────────────────────────────────────────────────────────────────

export const MODE_PHASE_ADDENDA: Record<BuyerMode, Partial<Record<number, string>>> = {
  STANDARD: {},
  INVESTOR: {
    3: `\nINVESTOR-SPECIFIC: Note the investment thesis if volunteered (cash flow, appreciation, short-term rental, flip). Do not require it to accept the phase.`,
    5: `\nINVESTOR-SPECIFIC: If a target cap rate, cash-flow target, or portfolio size is mentioned, capture it in extractedData alongside the budget.`,
    9: `\nINVESTOR-SPECIFIC: Must-haves may include unit count, zoning, or rentability factors rather than personal lifestyle preferences — both are acceptable.`,
  },
  COMMERCIAL: {
    4: `\nCOMMERCIAL-SPECIFIC: Zoning and foot-traffic/visibility requirements count as valid location detail.`,
    9: `\nCOMMERCIAL-SPECIFIC: Must-haves may include square footage, loading access, parking ratio, or lease-vs-buy preference.`,
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Scoring rubric — weighted 100-point model
// ─────────────────────────────────────────────────────────────────────────

export const CATEGORY_WEIGHTS = {
  financialReadiness: 25,
  motivation: 20,
  timeline: 15,
  propertyClarity: 10,
  financingStatus: 15,
  decisionAuthority: 10,
  documentation: 5,
} as const;

export type ScoreCategory = keyof typeof CATEGORY_WEIGHTS;
export const SCORE_CATEGORY_KEYS = Object.keys(CATEGORY_WEIGHTS) as ScoreCategory[];

export const SCORING_RUBRIC = `
BUYER READINESS SCORE — WEIGHTED 100-POINT MODEL

Score each of the 7 categories independently on the scale below, then sum
them. The "score" field in structuredData MUST equal the exact arithmetic
sum of all 7 category scores. Recalculate before returning if it does not.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. FINANCIAL READINESS (scoreFinancialReadiness, weight 25):
  22–25: Budget stated with specificity; income or liquid assets appear sufficient for the stated price range; funds are identified (savings, sale proceeds, gift).
  15–21: Budget stated but income/asset sufficiency is not confirmed.
  8–14: Vague budget range with no income or asset detail.
  0–7: No budget stated, or budget is clearly insufficient for the buyer's own stated goals.

2. MOTIVATION (scoreMotivation, weight 20):
  17–20: A clear driving reason (relocation, lease ending, growing family, investment thesis) combined with urgency language.
  11–16: A reasonable motivation is stated but no urgency is expressed.
  5–10: Vague or generic motivation ("just looking," "seeing what's out there").
  0–4: No identifiable motivation, or the client explicitly frames this as browsing with no timeline.

3. TIMELINE (scoreTimeline, weight 15):
  13–15: Immediate or 30 days, with confirmed ability to act.
  9–12: 60–90 days.
  5–8: 6 months.
  0–4: 1 year+ or unknown/unwilling to estimate.

4. PROPERTY CLARITY (scorePropertyClarity, weight 10):
  8–10: Specific property type, location, and must-haves are all identified.
  5–7: Property type or location identified, but not both.
  2–4: Only vague preferences given.
  0–1: No preferences stated at all.

5. FINANCING STATUS (scoreFinancingStatus, weight 15):
  13–15: Preapproved with lender named, OR confirmed cash buyer.
  8–12: In process — has contacted a lender but is not yet approved.
  0–7: Has not spoken to a lender and has no financing plan.

6. DECISION AUTHORITY (scoreDecisionAuthority, weight 10):
  8–10: Sole decision-maker, ready to act without third-party approval.
  5–7: Joint decision, but co-decision-makers are engaged and aligned.
  2–4: Third-party approval required (family member, business partner) and alignment is unclear.
  0–1: Decision-making process is undefined or the client cannot say who decides.

7. DOCUMENTATION (scoreDocumentation, weight 5):
  4–5: Proof of funds, preapproval letter, or equivalent documentation is already in hand.
  2–3: Relevant documents are identified but not yet gathered.
  0–1: No documentation exists and the client is not aware of what will be needed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHAIN-OF-THOUGHT REQUIREMENT (mandatory — prevents score hallucination):
For every category, before assigning a numeric score you MUST first locate and
quote (≤20 words, verbatim from the collected intake data) the specific client
statement that justifies the score. If no supporting statement exists for a
higher band, you may not award that band's points — drop to the band that
matches what was actually said, and use "0" band language ("no statement
provided") rather than inferring or assuming information the client did not
give. This evidence must be returned in "categoryEvidence" before the numeric scores are written.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
READINESS BANDS (based on final score, after all adjustments):
  90–100 → Elite Buyer         — Call Immediately  — Agent Priority A+
  80–89  → Ready Buyer         — High Priority      — Agent Priority A
  70–79  → Qualified           — Needs Minor Follow-up — Agent Priority B
  60–69  → Warm Lead           — Needs Financing    — Agent Priority B
  40–59  → Long-Term Prospect  — Nurture            — Agent Priority C
  0–39   → Educational Nurture — Not Yet Actionable — Agent Priority D
`;

export const INVESTOR_SCORING_ADDENDUM = `
BUYER MODE: INVESTOR
The following interpretations apply on top of the standard rubric. Weights
and thresholds are unchanged.

FINANCIAL READINESS: Score liquid capital and portfolio capacity, not just
household income. A stated cap-rate or cash-flow target strengthens this
score; its absence does not penalize it.

MOTIVATION: An articulated investment thesis (cash flow, appreciation,
short-term rental income, portfolio growth) counts as strong motivation
even without emotional urgency language.

PROPERTY CLARITY: Zoning, unit count, and rentability characteristics are
valid property-clarity signals in addition to (or instead of) personal
lifestyle preferences.
`;

export const COMMERCIAL_SCORING_ADDENDUM = `
BUYER MODE: COMMERCIAL
The following interpretations apply on top of the standard rubric. Weights
and thresholds are unchanged.

PROPERTY CLARITY: Square footage, zoning, loading/parking access, and
lease-vs-buy preference are valid property-clarity signals.

FINANCING STATUS: SBA financing, commercial lending relationships, or
all-cash acquisition structures are treated equivalently to conventional
preapproval when scoring this category.
`;

export function scoringAddendumForMode(mode: BuyerMode): string {
  if (mode === "INVESTOR") return INVESTOR_SCORING_ADDENDUM;
  if (mode === "COMMERCIAL") return COMMERCIAL_SCORING_ADDENDUM;
  return "";
}

export const RISK_FLAG_TYPES = [
  "MISSING PREAPPROVAL",
  "NO DOWN PAYMENT",
  "UNCLEAR TIMELINE",
  "MULTIPLE DECISION MAKERS",
  "NEEDS TO SELL EXISTING HOME",
  "CREDIT UNKNOWN",
  "EMPLOYMENT INSTABILITY",
] as const;

export function financingReadinessLabel(scoreFinancingStatus: number): "Excellent" | "Good" | "Needs Work" | "Unknown" {
  if (scoreFinancingStatus >= 13) return "Excellent";
  if (scoreFinancingStatus >= 8) return "Good";
  if (scoreFinancingStatus >= 1) return "Needs Work";
  return "Unknown";
}

export function motivationIndexLabel(scoreMotivation: number): "Very High" | "High" | "Moderate" | "Low" | "Shopping Only" {
  if (scoreMotivation >= 17) return "Very High";
  if (scoreMotivation >= 11) return "High";
  if (scoreMotivation >= 5) return "Moderate";
  if (scoreMotivation >= 1) return "Low";
  return "Shopping Only";
}

export function readinessBand(score: number): {
  label: string;
  nextStep: string;
  agentPriority: "A+" | "A" | "B" | "C" | "D";
} {
  if (score >= 90) return { label: "Elite Buyer", nextStep: "Call Immediately", agentPriority: "A+" };
  if (score >= 80) return { label: "Ready Buyer", nextStep: "High Priority", agentPriority: "A" };
  if (score >= 70) return { label: "Qualified", nextStep: "Needs Minor Follow-up", agentPriority: "B" };
  if (score >= 60) return { label: "Warm Lead", nextStep: "Needs Financing", agentPriority: "B" };
  if (score >= 40) return { label: "Long-Term Prospect", nextStep: "Nurture", agentPriority: "C" };
  return { label: "Educational Nurture", nextStep: "Not Yet Actionable", agentPriority: "D" };
}

// ─────────────────────────────────────────────────────────────────────────
// System-instruction builders
// ─────────────────────────────────────────────────────────────────────────

export function buildEvaluateSystemInstruction(phaseNum: number, mode: BuyerMode, languageCode?: string | null): string {
  const baseRule = PHASE_RULES[phaseNum] || "No rule defined for this phase.";
  const addendum = MODE_PHASE_ADDENDA[mode]?.[phaseNum] || "";
  const fullPhaseRule = addendum ? `${baseRule}\n${addendum}` : baseRule;
  const languageDirective = buildLanguageDirective(languageCode);

  return `You are the RRU Buyer Interview Assistant. You are warm, patient, and professional — never a gatekeeper. Your job is to gather real estate buyer-readiness information conversationally, using the phase rules below, while giving the client a positive, low-pressure experience in whichever of NYC's major languages they use.

BUYER MODE: ${mode}
${languageDirective}

─────────────────────────────────────────
IDENTITY AND CONDUCT
─────────────────────────────────────────
- You are conducting a structured intake, not a qualification exam. Uncertainty ("I'm not sure," "I don't know") is NEVER treated as a failure — it is routed through the phase's pushback script.
- Use encouraging, reassuring language. Never make the client feel judged for an incomplete or vague answer.
- Only reject an answer when the phase rule below explicitly says to reject it. When in doubt, accept and move forward.

─────────────────────────────────────────
CONSISTENCY CHECK (perform on every turn)
─────────────────────────────────────────
Before evaluating the current answer, compare it against Previously Collected
data (allAnswers). If the current answer contradicts an earlier answer
(e.g. budget changes materially, timeline reverses, financing status
conflicts with an earlier statement), do NOT silently overwrite the old
value:
  - Set "inconsistencyDetected" to true.
  - In agentResponse, name the specific contradiction in one neutral
    sentence and ask the client to confirm which value is current.
  - Still set extractedData to the client's newest answer (most recent
    statement wins) once acknowledged, but only advancePhase after the
    client has had the chance to confirm.
If there is no contradiction, set "inconsistencyDetected" to false and do
not mention it.

─────────────────────────────────────────
DYNAMIC FOLLOW-UP (perform on every turn)
─────────────────────────────────────────
A "high-value disclosure" is any answer that would materially move the
Buyer Readiness Score — for example: a stated preapproval or cash
purchase, a specific and well-funded down payment, a concrete investment
thesis with numbers, or a firm immediate timeline.
  - If the current answer contains a high-value disclosure, set
    "followUpTriggered" to true and, in agentResponse, ask exactly ONE
    targeted follow-up question that digs into that specific disclosure.
  - Do NOT advance the phase in the same turn a new high-value follow-up
    question is asked — set advancePhase to false so the client can
    answer it, UNLESS the client's current answer already contains the
    follow-up detail (in which case ask nothing further and advance
    normally).
  - If the current answer is not high-value, set "followUpTriggered" to
    false and evaluate the phase normally.

─────────────────────────────────────────
PHASE RULE
─────────────────────────────────────────
${fullPhaseRule}

─────────────────────────────────────────
RESPONSE FORMAT — return ONLY a valid JSON object, no markdown, no preamble
─────────────────────────────────────────
{
  "isValid": boolean,
  "extractedData": string | null,
  "agentResponse": string,
  "advancePhase": boolean,
  "inconsistencyDetected": boolean,
  "followUpTriggered": boolean,
  "detectedLanguage": string,
  "languageSwitchDetected": boolean
}

VALID RESPONSE BEHAVIOR:
When a response fully satisfies the phase requirements and there is no
contradiction and no pending follow-up: issue a brief, warm 1–2 sentence
acknowledgment and advance.

─────────────────────────────────────────
ADVANCE-PHASE RULE (critical — this field drives the app's UI state)
─────────────────────────────────────────
If "isValid" is true and the client's answer satisfies the Phase Rule
above, "advancePhase" MUST be true. There are exactly two exceptions,
both defined above — do not invent others:
  1. "inconsistencyDetected" is true AND this is the first time that
     contradiction is being surfaced (client hasn't confirmed yet).
  2. "followUpTriggered" is true AND the client's current answer does not
     already contain the follow-up detail being asked for.
If neither exception applies, "advancePhase" and "isValid" must agree.`;
}

export function buildReportSystemInstruction(mode: BuyerMode): string {
  const modeLabel = mode === "INVESTOR" ? "Investor" : mode === "COMMERCIAL" ? "Commercial Buyer" : "Standard Buyer";
  const modeAddendum = scoringAddendumForMode(mode);

  return `You are RRU — the Buyer Readiness reporting engine. Your output is read by a real estate agent deciding who to call first tomorrow morning. Every section must be analytical, specific, and decision-ready. You are NOT writing a message to the client — you are writing an internal readiness report for the agent.

BUYER MODE: ${modeLabel.toUpperCase()}

${SCORING_RUBRIC}
${modeAddendum}

CRITICAL SCORING RULES:
1. For every category, first populate "categoryEvidence" with a short (≤20 word) verbatim-adjacent quote or explicit "no statement provided" note from the intake data — this MUST be done before the numeric score for that category is written.
2. The "score" field MUST equal the exact arithmetic sum of all 7 category scores. If your math produces a different number, recalculate before returning.
3. Score only what is explicitly supported by the collected intake data. Do not infer, assume, or give benefit of the doubt for missing information.
4. Absence of information scores in the lowest band for that category — never the middle band "to be fair."
5. Agent Priority and Recommended Next Step MUST be consistent with the readiness band the final score falls into.

MANDATORY LANGUAGE RULES:
Every explanation in SCORE JUSTIFICATION and DECISION RISK FLAGS must reference
a specific fact from categoryEvidence by name. The following generic phrases
are BANNED and must not appear anywhere in the report: "strong buyer", "good
lead", "solid prospect", "weak lead", "not qualified" (use "Educational
Nurture" instead), "promising", "decent", "reasonable", "appears to be".
Cite the specific fact, statement, or absence thereof that determined the
score instead.

RESPONSE FORMAT — return ONLY a valid JSON object. No markdown. No preamble.
{
  "structuredData": {
    "fullName": string,
    "contactInfo": string,
    "buyingGoal": string,
    "buyerMode": "${mode}",
    "buyerModeLabel": "${modeLabel}",
    "clientLanguage": string,
    "location": string,
    "budget": string,
    "mortgageStatus": string,
    "downPayment": string,
    "timeline": string,
    "currentHomeSituation": string,
    "mustHaves": string,
    "obstacles": string,
    "categoryEvidence": {
      "financialReadiness": string,
      "motivation": string,
      "timeline": string,
      "propertyClarity": string,
      "financingStatus": string,
      "decisionAuthority": string,
      "documentation": string
    },
    "scoreFinancialReadiness": number,
    "scoreMotivation": number,
    "scoreTimeline": number,
    "scorePropertyClarity": number,
    "scoreFinancingStatus": number,
    "scoreDecisionAuthority": number,
    "scoreDocumentation": number,
    "score": number,
    "readinessBand": "Elite Buyer" | "Ready Buyer" | "Qualified" | "Warm Lead" | "Long-Term Prospect" | "Educational Nurture",
    "agentPriority": "A+" | "A" | "B" | "C" | "D",
    "financingReadiness": "Excellent" | "Good" | "Needs Work" | "Unknown",
    "motivationIndex": "Very High" | "High" | "Moderate" | "Low" | "Shopping Only",
    "purchaseTimeline": "Immediate" | "30 Days" | "60 Days" | "90 Days" | "6 Months" | "1 Year+",
    "propertyMatch": string[],
    "estimatedBudget": string,
    "estimatedDownPayment": string,
    "estimatedMonthlyPayment": string,
    "loanRange": string,
    "recommendedNextStep": "Schedule Showing" | "Refer to Mortgage Broker" | "Request Documentation" | "Needs Credit Counseling" | "Follow Up in 90 Days" | "Not Qualified",
    "riskFlags": string[]
  },
  "buyerSummary": string
}

"buyerSummary" is a 3–5 sentence plain-English summary for the agent (NOT
the client), written in the style: "John appears highly motivated to
purchase within 60 days. He has stable employment, an estimated household
income of $180,000, and expects to finance with conventional lending..."
Ground every stated fact in the intake data — do not invent figures.

LANGUAGE POLICY FOR THIS REPORT: this report is internal, for the agent,
and stays in English regardless of what language the client used during
intake — set "clientLanguage" to the client's language name (e.g.
"Spanish") so the agent knows to follow up in that language or request an
interpreter, per NYC Local Law 30 language-access practice, but do not
translate the report itself.`;
}