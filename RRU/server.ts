/**
 * server.ts — Local development server
 *
 * Runs Express + Vite dev middleware on a single port so that:
 * - POST /api/evaluate        →  LIRU-driven per-phase gatekeeping (Gemini)
 * - POST /api/generate-report →  LIRU-driven attorney triage report (Gemini)
 * - POST /api/intake          →  Email delivery via Resend
 * - Everything else           →  served by Vite (React SPA with HMR)
 *
 * Usage:  npm run dev   (calls: tsx server.ts)
 */

import express from "express";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { Resend } from "resend";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const PORT = process.env.PORT || 5173;

// ── Per-phase gatekeeping rules ───────────────────────────────────────────────
const PHASE_RULES: Record<number, string> = {
  1: `PHASE 1 — FULL LEGAL NAME:
ACCEPT: A plausible full legal name with at minimum a first name and last name separated by a space. Hyphens, apostrophes, and middle names are acceptable.
REJECT: Single word names. Initials only. Placeholder text ("John", "N/A", "Test", "Anonymous"). Gibberish. Fewer than 4 total characters. Anything that cannot plausibly be a real person's legal name.
extractedData: The trimmed full name exactly as provided.`,

  2: `PHASE 2 — CONTACT INFORMATION:
ACCEPT: At least ONE valid contact method: (a) a valid email in format x@x.x, OR (b) a phone number containing at least 7 digits in any format.
REJECT: "Call me." "You have it." Fewer than 7 digits with no valid email. Any response without a usable contact method.
extractedData: The trimmed contact details exactly as provided.`,

  3: `PHASE 3 — CASE DESCRIPTION:
ACCEPT: Must satisfy ALL THREE: (a) identifies the general legal matter type, (b) states at least one specific fact (who, what, where, or how), AND (c) contains at least 15 words. "Car accident" alone fails (b) and (c). "I was in a car accident on the BQE in March when the other driver ran a red light and hit my vehicle" passes all three.
REJECT: Case-type labels with no supporting facts. Vague statements. Any response under 15 words. Any response that does not include at least one concrete, verifiable detail.
NOTE: This phase seeds all downstream scoring. If borderline, reject and ask for one more specific fact. Do not accept minimally passing answers without noting what detail is still missing.
extractedData: The trimmed description exactly as provided.`,

  4: `PHASE 4 — INCIDENT DATE:
ACCEPT: A specific date, a month and year, or a reasonable approximate timeframe ("March 2024", "about 6 months ago", "last Tuesday"). Any reference that allows a statute of limitations calculation.
REJECT: "A long time ago." "Recently." "I don't remember." "Not sure." Any response with no usable temporal reference.
NOTE: If the incident appears to be more than 2 years ago, flag statute of limitations risk in agentResponse even while accepting. State: "SOL ALERT: This incident may fall outside the standard limitations period. Immediate attorney review of tolling facts required."
extractedData: The trimmed date reference exactly as provided.`,

  5: `PHASE 5 — INCIDENT LOCATION:
ACCEPT: A specific city AND state. A named borough with state ("the Bronx, NY"). A specific address, intersection, or named venue with city. "Manhattan, NY" is acceptable. "New York" alone is NOT.
REJECT: State name alone ("New York", "New Jersey", "California"). Country only. "Near my house." "I don't know." Any response that cannot establish jurisdiction or venue at minimum city level.
NOTE: "New York" without a borough or city is a rejection — New York is a state. Require specificity: borough, city, or address.
extractedData: The trimmed location exactly as provided.`,

  6: `PHASE 6 — PARTIES INVOLVED AND LIABILITY:
IDENTIFICATION TIERS — classify the client's answer into one of three tiers before deciding:

  TIER A — SUFFICIENT (named or specifically described):
    The opposing party is identified by: full or partial name, company/organization name, employer name, government agency, property owner name, or a uniquely identifying description (e.g., "driver of the red pickup truck with plate ABC-1234", "my supervisor Michael Torres at Walmart on Jerome Ave").
    → ACCEPT. extractedData = full response. advancePhase = true.

  TIER B — VAGUE BUT USABLE (role only, no identifying details):
    The opposing party is described only by generic role with no identifying information: "a driver", "my employer", "the landlord", "a coworker", "the store", "the other car".
    → DO NOT ADVANCE IMMEDIATELY.
    → Set isValid = false, advancePhase = false.
    → agentResponse must:
        (1) Acknowledge what the client said.
        (2) Explain that a generic role alone is insufficient for a strong liability claim.
        (3) Ask for ONE OR MORE of the following as available: full name, company or employer name, vehicle plate number, business address, badge number, or any other uniquely identifying detail.
        (4) Explicitly state: "If you do not have this information right now, say so and I will note it — but be aware this will reduce your case evaluation score."
    → If the client responds to the follow-up with identifying detail → upgrade to Tier A, accept, advance.
    → If the client responds that they do not have identifying details → accept as Tier C (see below), advance with internal flag.

  TIER C — VAGUE AFTER FOLLOW-UP (role only, client cannot provide more):
    The client has been asked for identifying details and has confirmed they cannot provide them. The opposing party remains identified by role only.
    → ACCEPT. advancePhase = true.
    → extractedData = the client's response prefixed with "[VAGUE-DEFENDANT]: " so the scoring engine can detect this flag.
    → agentResponse must confirm progression and state: "This has been noted. Cases without a clearly identified opposing party carry a significant liability scoring penalty. Our legal team will attempt to identify the responsible party during their review."

REJECT ENTIRELY (no party at all):
    "I don't know." "Not sure." "Someone." "I have no idea." Any response that provides no opposing party — not even a generic role.
    → isValid = false, advancePhase = false.
    → agentResponse must state that at minimum a role or description is required to proceed, and ask who or what type of entity the client believes caused their harm.

extractedData rules:
  - Tier A: trimmed response as provided.
  - Tier B follow-up success: trimmed combined response as provided.
  - Tier C: trimmed response prefixed with "[VAGUE-DEFENDANT]: ".
  - Rejected: null.`,

  7: `PHASE 7 — INJURIES AND DAMAGES:
ACCEPT: Names at least ONE specific, concrete harm: physical injuries with description, property damage with description, financial losses (medical bills, lost wages, out-of-pocket costs), or documented ongoing harm. "Broken left arm, required surgery, $12,000 in medical bills and 3 weeks missed work" is strong. "I was hurt and had some damage" is not acceptable.
REJECT: "Yes." "A lot." "Some damage." "I was hurt." Single-word or single-phrase responses with no specifics. Any response that does not name and describe at least one concrete harm.
NOTE: Vague answers here directly result in a Damages score of 0–1. If the user names a harm but provides no details, accept but prompt: "To strengthen your case evaluation, please describe the severity, treatment received, and any financial impact if possible."
extractedData: The trimmed response exactly as provided.`,

  8: `PHASE 8 — PRIOR REPRESENTATION:
ACCEPT: A clear yes or no with any available context. "No, I have not." "Yes, I retained an attorney but they withdrew after 6 months." Both are acceptable with appropriate context.
REJECT: "Maybe." "I think so." "Sort of." Any response that does not take a clear yes or no position.
NOTE: Prior representation ending in withdrawal, dismissal, adverse outcome, or fee dispute is a red flag. State it explicitly: "Prior representation noted — this may raise res judicata, malpractice, or conflict of interest concerns. Attorney must review before accepting."
extractedData: The trimmed response exactly as provided.`,

  9: `PHASE 9 — URGENCY AND DEADLINES:
ACCEPT: A clear yes with specific deadline details, OR a clear statement that no deadlines are known ("No urgent deadlines that I'm aware of.").
REJECT: "I'm not sure." "Maybe." Vague non-answers. Any response that does not take a clear position on the presence or absence of deadlines.
NOTE: Any mentioned deadline — statute of limitations expiry, scheduled court date, insurance filing window, arbitration deadline — must be flagged as HIGH URGENCY: "DEADLINE ALERT: [describe deadline]. Immediate attorney review required."
extractedData: The trimmed response exactly as provided.`,

  10: `PHASE 10 — ADDITIONAL NOTES:
ACCEPT: Any substantive response including "Nothing else to add" or "No."
REJECT: Blank. A single character. Clearly nonsensical input.
extractedData: The trimmed notes as provided, or "None." if the user indicates nothing further.`,
};

const SCORING_RUBRIC = `
READINESS SCORE — 12-POINT RUBRIC

Assign each of the 4 dimensions a score of 0, 1, 2, or 3.
Total score = sum of all 4 dimensions (maximum 12).
Apply penalty rules BEFORE finalizing each dimension score (minimum 0 per dimension).
The "score" field in structuredData must equal scoreEvidence + scoreDamages + scoreLiability + scoreClientReadiness exactly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DIMENSION 1 — EVIDENCE (scoreEvidence, 0–3):
  3: Client has confirmed, named documentation — police reports, medical records, photos, contracts, communications, dashcam footage, or other physical evidence. Specific items stated.
  2: Evidence likely exists but client has not confirmed possession (e.g., "a police report was filed", "there were security cameras").
  1: Client believes evidence may exist but is uncertain or has nothing confirmed. No specific items referenced.
  0: No evidence mentioned, no documentation referenced, or client explicitly has nothing.

DIMENSION 2 — DAMAGES (scoreDamages, 0–3):
  3: Documented, quantifiable damages with specifics — medical bills with amounts, lost wage figures, property damage estimates, or clear ongoing measurable harm.
  2: Real damages described but not yet quantified (e.g., "I was hospitalized for two weeks and am still in physical therapy").
  1: Vague or minor damages with no specifics ("I was hurt", "there was some damage", "I lost time").
  0: No damages described, purely speculative harm, or client cannot identify any concrete loss.

DIMENSION 3 — LIABILITY CLARITY (scoreLiability, 0–3):
  3: Named opposing party with a clear, direct causal link. A coherent liability theory is identifiable (negligence, breach of contract, wrongful termination, premises liability, etc.).
  2: Opposing party identified by name or role, but liability theory is incomplete, causation is partially established, or fault is disputed.
  1: Opposing party vaguely described (e.g., "a driver", "my employer") with no name or identifying detail, or causation is unclear.
  0: No opposing party identified at all. Client cannot explain who caused the harm or how.

DIMENSION 4 — CLIENT READINESS (scoreClientReadiness, 0–3):
  3: Organized, coherent, and specific across all 10 phases. Has documentation in hand. Provided a clear timeline. Understands urgency. Answered all phases without requiring repeated follow-up.
  2: Cooperative and mostly specific. Some gaps in recall or preparation but generally credible and responsive.
  1: Vague, inconsistent, or unprepared. Multiple phases required follow-up to extract minimum acceptable data.
  0: Evasive, contradictory, uncooperative, or clearly unprepared to proceed with legal representation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REWARD RULES (apply before penalties; do not exceed 3 per dimension):
  + Named, verifiable opposing party with established direct causal chain → +1 to scoreLiability if currently 2
  + Multiple confirmed, named evidence items → +1 to scoreEvidence if currently 2
  + Ongoing or escalating harm with documented medical treatment → +1 to scoreDamages if currently 2
  + Client proactively provided a full timeline, has records compiled, and shows urgency awareness → +1 to scoreClientReadiness if currently 2

PENALTY RULES (apply after rewards; floor is 0 per dimension):
  - No identified opposing party (name, role, or description) → scoreLiability − 2
  - No documentation of any kind confirmed → scoreEvidence − 1
  - SOL risk (incident > 2 years ago with no tolling facts stated) → scoreClientReadiness − 1; add RED FLAG
  - Prior representation ending adversely (withdrawal, dismissal, fee dispute) → scoreClientReadiness − 1; add RED FLAG
  - Vague or inconsistent answers across 3 or more phases → scoreClientReadiness − 1
  - Damages purely speculative with no physical, financial, or property basis → scoreDamages − 1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIORITY THRESHOLDS (based on final score after all adjustments):
  10–12 → HIGH     — Take immediately. Strong case, clear liability, documented damages.
  7–9   → MEDIUM  — Review. Viable but needs investigation or documentation gaps filled.
  4–6   → LOW      — Weak. Significant gaps. Pursue only if capacity allows.
  0–3   → DECLINE — Do not pursue. Insufficient basis for representation.

RECOMMENDATION MAPPING:
  HIGH   → ACCEPT
  MEDIUM → REVIEW
  LOW    → DEFER
  DECLINE → DECLINE
`;

const PI_KEYWORDS = [
  "accident", "crash", "collision", "hit", "struck", "injury", "injured", "injuries",
  "hurt", "pain", "fracture", "broken", "surgery", "hospital", "hospitalized", "emergency",
  "ambulance", "stitches", "concussion", "spinal", "spine", "whiplash", "disability",
  "paralysis", "scar", "burn", "slip", "fall", "trip", "premises", "dog bite", "assault",
  "malpractice", "negligence", "wrongful death", "death", "fatality", "medical", "treatment",
  "doctor", "physician", "physical therapy", "rehab", "rehabilitation", "workers comp",
  "workers' compensation", "workplace injury", "on the job", "product defect", "defective",
  "drunk driver", "dui", "reckless", "pedestrian", "bicycle", "motorcycle",
];

function detectCaseMode(caseDescription: string): "PI" | "GENERAL" {
  if (!caseDescription || caseDescription.trim().length === 0) return "GENERAL";
  const lower = caseDescription.toLowerCase();
  const cleaned = lower.replace(/^\[vague-defendant\]:\s*/i, "");
  return PI_KEYWORDS.some((kw) => cleaned.includes(kw)) ? "PI" : "GENERAL";
}

const PI_PHASE_ADDENDA: Partial<Record<number, string>> = {
  3: `
PI-SPECIFIC (apply because this appears to be a Personal Injury matter):
  - Require the mechanism of injury: HOW did the injury occur? (e.g., direct impact, slip, fall, product failure)
  - Require confirmation that a physical injury or bodily harm occurred (not just property damage alone)
  - If mechanism is absent, prompt: "Please describe how the injury occurred — what specifically caused the harm to your body?"`,

  5: `
PI-SPECIFIC (apply because this appears to be a Personal Injury matter):
  - The location is especially important for establishing premises liability, jurisdiction, and venue.
  - If the incident occurred on a specific property (store, workplace, road), require the property name or address in addition to city/state.`,

  6: `
PI-SPECIFIC (apply because this appears to be a Personal Injury matter):
  - In addition to the standard tier classification above, also ask:
    (a) Whether the opposing party had insurance (auto insurance, business liability, workers' comp carrier)
    (b) Whether a claim or report was filed with any insurer
  - Insurance information significantly affects recoverability and case value. Note in agentResponse if not provided.`,

  7: `
PI-SPECIFIC (apply because this appears to be a Personal Injury matter):
  - Require specific injury details: body part(s) affected, type of injury (fracture, laceration, soft tissue, etc.)
  - Require treatment details: ER visit, hospitalization, surgery, ongoing physical therapy, specialist visits
  - Require financial impact where known: medical bills (amounts if available), lost wages (duration and approximate amount)
  - If the client lists injuries but no treatment: ask "Did you receive any medical treatment? If so, from whom and when?"
  - Property damage alone without bodily injury should be flagged: PI cases require bodily harm. If only property damage is described, note this reduces PI case viability.`,
};

const GENERAL_MODE_SCORING_ADDENDUM = `
CASE MODE: GENERAL LEGAL MATTER
The following dimension interpretations apply for non-PI cases. Thresholds, arithmetic, penalties, and rewards are identical.

DIMENSION 1 — EVIDENCE (scoreEvidence, 0–3) — GENERAL INTERPRETATION:
  3: Client has confirmed, named documentation — contracts, communications (emails, texts, letters), photographs, financial records, official filings, written agreements, or other specific documents.
  2: Evidence likely exists (e.g., "there was a written contract", "emails were exchanged") but client has not confirmed possession or access.
  1: Client believes documentation may exist but is uncertain. No specific items referenced.
  0: No documentation mentioned or client has nothing.

DIMENSION 2 — DAMAGES/IMPACT (scoreDamages, 0–3) — GENERAL INTERPRETATION:
  3: Documented, quantifiable financial or legal harm — specific dollar amounts, court judgments, documented losses, breach consequences, or ongoing measurable impact.
  2: Real impact described but not yet quantified (e.g., "I lost the contract", "my business was damaged but I don't have the final number").
  1: Vague or speculative harm with no specifics ("I was affected", "it hurt my business").
  0: No impact described or purely speculative harm with no identifiable loss.

DIMENSION 3 — LIABILITY/CLAIM CLARITY (scoreLiability, 0–3) — GENERAL INTERPRETATION:
  3: Named opposing party with a clear legal theory — breach of contract, fraud, defamation, wrongful termination, discrimination, landlord-tenant violation, etc. Causation is established.
  2: Opposing party identified but legal theory is incomplete or facts are disputed.
  1: Opposing party vaguely described or legal theory is unclear.
  0: No opposing party identified. Client cannot explain the basis of the claim.

DIMENSION 4 — CLIENT READINESS (scoreClientReadiness, 0–3) — GENERAL INTERPRETATION:
  Identical to PI mode. Assess organization, specificity, and cooperation across all 10 phases.
`;

async function main() {
  const app = express();
  app.use(express.json());

  if (!process.env.GEMINI_API_KEY) {
    console.error("[server] FATAL: GEMINI_API_KEY is not set in .env");
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // ── Evaluation Route ──────────────────────────────────────────────────────
  app.post("/api/evaluate", async (req, res) => {
    try {
      const { phase, question, answer, allAnswers } = req.body;

      if (!phase || !question || answer === undefined || answer === null) {
        res.status(400).json({ error: "Missing required fields: phase, question, answer" });
        return;
      }

      const phaseNum = Number(phase);
      if (isNaN(phaseNum) || phaseNum < 1 || phaseNum > 10) {
        res.status(400).json({ error: "Invalid phase number" });
        return;
      }

      const caseDescription = String(allAnswers?.caseType || allAnswers?.caseDescription || "");
      const caseMode = detectCaseMode(caseDescription);

      const baseRule = PHASE_RULES[phaseNum];
      const piAddendum = caseMode === "PI" ? (PI_PHASE_ADDENDA[phaseNum] || "") : "";
      const fullPhaseRule = piAddendum ? `${baseRule}\n${piAddendum}` : baseRule;

      // REBRANDED: Fortress Intake AI -> LIRU
      const systemInstruction = `You are LIRU. You are a legal intake gatekeeper, not an assistant. You do not converse. You do not encourage. You enforce intake standards on behalf of the reviewing attorney.

CASE MODE: ${caseMode === "PI" ? "PERSONAL INJURY — Apply PI-specific requirements where indicated below." : "GENERAL LEGAL MATTER — Apply standard gatekeeping. Do not require PI-specific details (medical records, injury description) unless the client volunteers them."}

─────────────────────────────────────────
IDENTITY AND CONDUCT
─────────────────────────────────────────
- You are a pre-attorney qualification filter. Every response you issue is either an acceptance or a rejection.
- You do not make small talk, offer encouragement, or use conversational filler.
- You do not apologize for enforcing standards.
- You do not soften rejections with empathy, hedging, or polite phrasing that reduces authority.
- Calm, direct, and neutral at all times. Not aggressive. Not rude. Not accommodating.

─────────────────────────────────────────
ENFORCEMENT MANDATE
─────────────────────────────────────────
- Every phase has defined minimum data standards. Enforce them without exception.
- If a response fails, it is rejected. State the failure. Name the gap. Require the correction.
- Do NOT infer, guess, or fill in missing information on the client's behalf.
- Do NOT advance the phase if required data is absent.
- Do NOT accept a borderline answer to avoid friction. When in doubt, reject and require clarification.
- Evasive or uncooperative behavior must be noted explicitly in agentResponse.

─────────────────────────────────────────
BANNED LANGUAGE — NEVER USE
─────────────────────────────────────────
The following phrases and their equivalents are prohibited in agentResponse under any circumstance:
- "Can you clarify..." / "Could you clarify..."
- "Please provide more detail..."
- "Could you explain..."
- "Would you mind..."
- "I understand, but..."
- "Thank you for sharing..."
- "I appreciate..."
- "That's helpful, however..."
- Any phrase that softens a rejection or implies the answer was partially acceptable when it was not.

─────────────────────────────────────────
REQUIRED REJECTION STRUCTURE
─────────────────────────────────────────
Every failed response MUST follow this exact three-part structure. No deviation.

  PART A — REJECTION STATEMENT:
    "This is insufficient to evaluate [specific element]."
    OR: "This response does not meet the minimum requirement for [specific element]."
    OR: "I do not have enough information to proceed. [Specific element] has not been provided."

  PART B — REASON:
    State exactly what is missing or why the answer fails. One sentence. Be specific.
    Example: "No specific opposing party has been identified — a role description alone is not sufficient."
    Example: "The incident date provided contains no usable temporal reference."

  PART C — REQUIRED CORRECTION:
    State exactly what must be provided. One sentence. Direct instruction.
    Example: "Provide the full name, business name, or a uniquely identifying description of the responsible party."
    Example: "State the date, month and year, or an approximate timeframe that allows a timeline to be established."

─────────────────────────────────────────
CONSEQUENCE LANGUAGE — USE INSTEAD OF SCORING REFERENCES
─────────────────────────────────────────
Do NOT reference scores, numbers, calculations, or internal systems.
When communicating the impact of a weak or missing answer, use consequence language:
- "Without this, liability cannot be established."
- "This cannot be assessed without a named or identified opposing party."
- "This limits the ability to evaluate damages."
- "Without a verifiable location, jurisdiction cannot be determined."
- "This weakens the case evaluation and cannot be accepted as filed."
- "Without documentation, this claim cannot be substantiated."

─────────────────────────────────────────
VALID RESPONSE BEHAVIOR
─────────────────────────────────────────
When a response fully satisfies the phase requirements:
- Issue a brief, neutral acknowledgment. 1–2 sentences maximum.
- Do not praise. Do not encourage. Do not use warm language.
- If a flag applies (SOL risk, vague defendant, prior adverse representation, urgent deadline, no documentation): state it directly and factually.`;

      const currentDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });

      const prompt = `Today's date: ${currentDate}. Use this as your reference for all date-related evaluations. Do NOT reject any date that falls on or before today.

Phase: ${phaseNum}
Question: "${question}"
Client Answer: "${answer.trim()}"
Previously Collected: ${JSON.stringify(allAnswers || {})}

Evaluate against Phase ${phaseNum} enforcement rules. Return your JSON response.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: { systemInstruction, responseMimeType: "application/json" },
      });

      const responseText = (response.text || "{}").trim();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        console.error("[server] Malformed LIRU evaluation response:", responseText);
        res.status(500).json({ error: "LIRU returned malformed response" });
        return;
      }

      const result = {
        isValid: Boolean(parsed.isValid),
        extractedData: parsed.extractedData ?? null,
        agentResponse:
          typeof parsed.agentResponse === "string" && parsed.agentResponse.trim().length > 0
            ? parsed.agentResponse.trim()
            : "Your response does not meet the minimum requirements for this phase. Please provide the specific information requested.",
        advancePhase:
          Boolean(parsed.advancePhase) &&
          Boolean(parsed.isValid) &&
          parsed.extractedData !== null &&
          typeof parsed.extractedData === "string" &&
          (parsed.extractedData as string).trim().length > 0,
      };

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[server] LIRU Evaluation error:", message);
      res.status(500).json({ error: "Failed to evaluate input", detail: message });
    }
  });

  // ── Report Generation Route ───────────────────────────────────────────────
  app.post("/api/generate-report", async (req, res) => {
    try {
      const { answers } = req.body;

      if (!answers || typeof answers !== "object") {
        res.status(400).json({ error: "Missing or invalid answers object" });
        return;
      }

      const caseDescription = String(answers.caseType || "");
      const caseMode = detectCaseMode(caseDescription);
      const caseModeLabel = caseMode === "PI" ? "Personal Injury" : "General Legal Matter";
      const modeRubricAddendum = caseMode === "GENERAL" ? GENERAL_MODE_SCORING_ADDENDUM : "";

      // REBRANDED: Fortress Intake AI -> LIRU
      const systemInstruction = `You are LIRU — triage report engine. Your output is read by attorneys making an immediate case decision: ACCEPT, REVIEW, DEFER, or DECLINE. Every section must be analytical and decision-ready. You are NOT summarizing for the client. You are writing a professional internal case evaluation for legal counsel.

CASE MODE: ${caseModeLabel.toUpperCase()}
${caseMode === "PI"
  ? "This is a Personal Injury matter. Emphasize: injury mechanism, medical treatment, insurance coverage, liability fault chain, and physical/financial damages. Use PI-specific legal terminology."
  : "This is a General Legal Matter. Emphasize: nature of the dispute, documentation, legal theory, financial or legal impact, and key parties. Do NOT frame the report in PI terms unless the facts require it."}

${SCORING_RUBRIC}
${modeRubricAddendum}

CRITICAL SCORING RULES:
1. Apply reward rules first (max 3 per dimension).
2. Apply penalty rules after rewards (floor 0 per dimension).
3. The "score" field MUST equal the arithmetic sum of scoreEvidence + scoreDamages + scoreLiability + scoreClientReadiness. If your math produces a different number, recalculate before returning.
4. Score only what is explicitly supported by the collected intake data. Do not infer, assume, or give benefit of the doubt for missing information.
5. Absence of information always scores 0 for that criterion.
6. The recommendation MUST be consistent with the priority threshold: HIGH→ACCEPT, MEDIUM→REVIEW, LOW→DEFER, DECLINE→DECLINE.

ATTORNEY CONFIDENCE LAYER — MANDATORY LANGUAGE RULES:
Every explanation in SCORING JUSTIFICATION, SCORE DRIVERS, and CRITICAL GAPS must:
- Reference a specific fact from the collected intake data by name. Example: "Client confirmed police report filed and photos taken → evidence score 3/3."
- State any applied penalty explicitly by name. Example: "No opposing party named — LIABILITY PENALTY −2 applied → scoreLiability reduced to 0."
- State any applied reward explicitly. Example: "Multiple confirmed evidence items — EVIDENCE REWARD +1 applied → scoreEvidence raised to 3."
- NEVER use generic phrases. The following are BANNED and must not appear anywhere in the report:
  BANNED: "strong case", "good evidence", "solid claim", "weak case", "lacks merit", "promising", "decent", "reasonable", "appears to be"
  REQUIRED INSTEAD: Cite the specific fact, document, or absence thereof that determined the score.
- CRITICAL GAPS must name the specific missing item. Not "documentation is missing" but "No police report, medical records, or photos confirmed by client."
- PRIORITY RATIONALE must name the score, the single strongest factor, and the single biggest risk in one direct sentence each.

RESPONSE FORMAT — return ONLY a valid JSON object. No markdown. No preamble.
{
  "structuredData": {
    "fullName": string,
    "contactInfo": string,
    "caseType": string,
    "caseMode": "${caseMode}",
    "caseModeLabel": "${caseModeLabel}",
    "incidentDate": string,
    "incidentLocation": string,
    "partiesInvolved": string,
    "injuriesDamages": string,
    "priorRepresentation": string,
    "urgencyDeadlines": string,
    "additionalNotes": string,
    "scoreEvidence": number,
    "scoreDamages": number,
    "scoreLiability": number,
    "scoreClientReadiness": number,
    "score": number,
    "priority": "HIGH" | "MEDIUM" | "LOW" | "DECLINE",
    "recommendation": "ACCEPT" | "REVIEW" | "DEFER" | "DECLINE",
    "redFlags": string[]
  },
  "attorneyReport": string
}

The "attorneyReport" must be plain text using the exact structure below.
ALL CAPS headers. No markdown. Use "- " prefix for list items. "•" prefix for sub-items under SCORE DRIVERS. No other bullet symbols.

FORTRESS LEGAL SYSTEMS — CONFIDENTIAL CASE TRIAGE REPORT
Generated: [current timestamp] ET  |  Ref: FLS-[random 4-digit number]
CASE TYPE: ${caseModeLabel.toUpperCase()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRIAGE DECISION: [ACCEPT / REVIEW / DEFER / DECLINE]
READINESS SCORE: [X]/12  |  PRIORITY: [HIGH / MEDIUM / LOW / DECLINE]

PRIORITY RATIONALE:
[Exactly 2 sentences. Sentence 1: Link the numeric score to the decision using the single strongest fact from intake. Sentence 2: State the single biggest risk or gap that limits or threatens the case. Do not use banned phrases. Example: "Score of 9/12 driven by named defendant (ABC Transport Corp), documented hospitalization, and confirmed police report — classified MEDIUM/REVIEW pending insurance verification. Biggest risk: no insurance carrier identified for the opposing party, making recoverability unconfirmed."]

DECISION CONFIDENCE: [HIGH / MEDIUM / LOW]
[The server will override this value — you must still generate it. Derive it from data completeness, NOT case strength alone. Use these rules strictly:
  HIGH: Evidence ≥ 2 AND Liability ≥ 2 AND no more than 1 critical gap. All core facts are confirmed and documented.
  MEDIUM: Mixed scores, OR 2–3 critical gaps, OR key facts described but unconfirmed.
  LOW: Evidence ≤ 1, OR Liability ≤ 1, OR 3 or more critical gaps, OR missing defendant, OR no documentation of any kind.
A high score with missing data must result in MEDIUM or LOW confidence. Do NOT inflate confidence without documented evidence. Confidence must align with SCORING JUSTIFICATION and CRITICAL GAPS — any inconsistency will be corrected server-side.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCORE BREAKDOWN:
  Evidence .............. [X]/3
  Damages/Impact ........ [X]/3
  Liability Clarity ..... [X]/3
  Client Readiness ...... [X]/3
  ─────────────────────────────
  TOTAL ................. [X]/12

SCORING JUSTIFICATION:
- Evidence [X]/3: [State what specific documents or evidence the client confirmed, OR state what was absent. Name each item. State any penalty applied. E.g.: "Client confirmed police report filed and two photos taken at scene → scoreEvidence 3/3." OR "No documentation of any kind confirmed by client — NO DOCUMENTATION PENALTY −1 applied → scoreEvidence 0/3."]
- Damages/Impact [X]/3: [State the specific injuries, amounts, or losses described, OR state the absence. E.g.: "Client reported fractured right wrist requiring surgery, $8,400 ER bill confirmed, 3 weeks lost wages at $1,200/week → scoreDamages 3/3." OR "Client stated only 'I was hurt' with no treatment, no bills, no wage loss described → scoreDamages 1/3."]
- Liability Clarity [X]/3: [State the party identified and the causal link established, OR state the gap and any penalty. E.g.: "Named defendant: Metro Logistics LLC. Causal chain: client's vehicle was rear-ended at red light by company truck. Negligence theory clear → scoreLiability 3/3." OR "[VAGUE-DEFENDANT] flag active — party identified by role only ('a driver'), no name or plate → LIABILITY CEILING enforced → scoreLiability 1/3."]
- Client Readiness [X]/3: [State the basis for the readiness score. E.g.: "Client provided complete, specific answers across all 10 phases with no follow-up required, has documentation in hand → scoreClientReadiness 3/3." OR "Client required follow-up on 3 phases, could not name opposing party, and had no documentation → scoreClientReadiness 1/3."]

SCORE DRIVERS:
- Positive Factors:
  [List each fact that increased the score. Use "•" prefix. Reference the actual fact. If none: "• No significant positive factors identified."]
  • [e.g., "Named, insured defendant with confirmed business address → +1 to Liability Clarity"]
  • [e.g., "Police report and ER records confirmed in client's possession → Evidence score 3/3"]

- Negative Factors / Penalties:
  [List each penalty or weakness. Use "•" prefix. State the penalty by name and amount. If none: "• No penalties applied."]
  • [e.g., "No insurance information provided → INSURANCE GAP flag added, recoverability unconfirmed"]
  • [e.g., "[VAGUE-DEFENDANT] flag → LIABILITY CEILING enforced, scoreLiability capped at 1"]
  • [e.g., "Incident date of March 2021 → SOL RISK flag, −1 to Client Readiness"]

CRITICAL GAPS:
[List each specific missing item that materially affects the case evaluation. Use "- " prefix. Be explicit — name the missing item, not a category. If no gaps: "- No critical gaps identified."]
- [e.g., "No named defendant — opposing party must be identified before case can be accepted"]
- [e.g., "No medical records or treatment history confirmed — damages score cannot be elevated without documentation"]
- [e.g., "Insurance carrier for opposing party unknown — recoverability of damages unconfirmed"]
- [e.g., "Incident date is approximate — exact date required for SOL calculation"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RED FLAGS:
[Each flag formatted as: "- [FLAG TYPE]: [specific description and risk]"
Types: SOL RISK, PRIOR REPRESENTATION, UNIDENTIFIED PARTY, NO DOCUMENTATION, INCONSISTENT TESTIMONY, DEADLINE ALERT, CONFLICT RISK, INSURANCE GAP (PI only), NO BODILY INJURY (PI only)
If none: "- None identified."]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1: CLIENT IDENTIFICATION
  Full Name:    [value]
  Contact:      [value]

SECTION 2: INCIDENT SUMMARY
[3–5 sentences synthesizing the case. Identify the probable legal theory. For PI: state injury mechanism, fault chain, and insurance posture. For General: state the nature of the dispute, legal theory, and key factual gaps. Note any material gaps.]

SECTION 3: INCIDENT DETAILS
  Date:          [value]
  Location:      [value]
[If SOL risk: "SOL ALERT: Incident date suggests the statute of limitations may be approaching or expired. Immediate verification of tolling facts required before acceptance."]

SECTION 4: LIABILITY ANALYSIS
  Opposing Party: [value]
[2–3 sentences. Is the party clearly named or merely described? Is causation established or implied? What is the liability theory? What evidentiary gap most threatens this claim?]

SECTION 5: DAMAGES ASSESSMENT
[2–3 sentences. For PI: physical injuries, treatment, financial harm, recovery potential. For General: financial loss, legal exposure, contractual/statutory damages available. Are damages documented or speculative?]

SECTION 6: EVIDENCE INVENTORY
[List each confirmed evidence item on its own line prefixed with "- ". If nothing confirmed: "- No documentation confirmed by client." Then note: "Expected evidence not mentioned: [for PI: police report, medical records, photos, insurance info; for General: contracts, communications, financial records, filings]."]

SECTION 7: LEGAL HISTORY
  Prior Representation: [value]
[If yes: Note specific risk — res judicata, statute of limitations tolling, malpractice claim, fee lien, or conflict of interest as applicable. If no: "No prior representation reported."]

SECTION 8: URGENCY MATRIX
[List each deadline explicitly with "- " prefix. If none reported: "- No deadlines reported by client. Standard SOL verification required before acceptance."]

SECTION 9: CLIENT PROFILE
[2 sentences. Assess the client's reliability, organization, and readiness as a witness based on the quality, consistency, and specificity of their intake responses across all 10 phases. Be direct — note if the client was vague, evasive, or required repeated follow-up."]

SECTION 10: ANALYST RECOMMENDATION
  Decision: [ACCEPT / REVIEW / DEFER / DECLINE]
[4 sentences: (1) Justify the decision based on the score and key facts. (2) State the single biggest risk factor for this case. (3) State what would need to change to elevate the priority or what confirms the decline. (4) State the first concrete action the attorney should take.]`;

  const prompt = `Generate the triage report from this intake data:\n\n${JSON.stringify(answers, null, 2)}\n\nApply all scoring rules strictly. Verify your arithmetic before returning. The "score" field must equal scoreEvidence + scoreDamages + scoreLiability + scoreClientReadiness. Return the JSON object.`;

  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: prompt,
    config: { systemInstruction, responseMimeType: "application/json" },
  });

  const responseText = (response.text || "{}").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.error("[server] Malformed LIRU report response:", responseText);
    res.status(500).json({ error: "LIRU returned malformed report response" });
    return;
  }

  if (!parsed.structuredData || !parsed.attorneyReport) {
    console.error("[server] LIRU report missing required fields:", Object.keys(parsed));
    res.status(500).json({ error: "LIRU report was incomplete" });
    return;
  }

  const sd = parsed.structuredData as Record<string, unknown>;

  let sE = Math.min(3, Math.max(0, Number(sd.scoreEvidence        ?? 0)));
  let sD = Math.min(3, Math.max(0, Number(sd.scoreDamages         ?? 0)));
  let sL = Math.min(3, Math.max(0, Number(sd.scoreLiability       ?? 0)));
  let sC = Math.min(3, Math.max(0, Number(sd.scoreClientReadiness ?? 0)));

  const partiesRaw = String(answers.partiesInvolved || "");
  const isVagueDefendant = partiesRaw.trimStart().toUpperCase().startsWith("[VAGUE-DEFENDANT]");

  if (isVagueDefendant) {
    if (sL > 1) {
      console.warn(`[server] Vague-defendant detected — capping scoreLiability from ${sL} to 1.`);
      sL = 1;
    }
    if (!Array.isArray(sd.redFlags)) sd.redFlags = [];
    const flags = sd.redFlags as string[];
    const vagueFlag = "UNIDENTIFIED PARTY: Opposing party not identified by name or organization. Liability theory is incomplete. Attorney must identify the responsible party before case acceptance.";
    if (!flags.some((f: string) => f.includes("UNIDENTIFIED PARTY"))) {
      flags.push(vagueFlag);
    }
  }

  sd.scoreEvidence        = sE;
  sd.scoreDamages         = sD;
  sd.scoreLiability       = sL;
  sd.scoreClientReadiness = sC;
  sd.caseMode             = caseMode;
  sd.caseModeLabel        = caseModeLabel;

  const computedScore = sE + sD + sL + sC;
  if (Number(sd.score) !== computedScore) {
    console.warn(`[server] Score corrected — LIRU returned ${sd.score}, server computed ${computedScore}.`);
  }
  sd.score = computedScore;

  const finalScore = sd.score as number;
  if (finalScore >= 10 && !isVagueDefendant) {
    sd.priority       = "HIGH";
    sd.recommendation = "ACCEPT";
  } else if (finalScore >= 10 && isVagueDefendant) {
    sd.priority       = "MEDIUM";
    sd.recommendation = "REVIEW";
    console.warn("[server] HIGH score with vague defendant — capped to MEDIUM/REVIEW.");
    if (!Array.isArray(sd.redFlags)) sd.redFlags = [];
    const flags2 = sd.redFlags as string[];
    if (!flags2.some((f: string) => f.includes("HIGH SCORE"))) {
      flags2.push("HIGH SCORE / UNIDENTIFIED PARTY: Case scored HIGH but opposing party is unidentified. Cannot accept without identifying the defendant. Classified as REVIEW.");
    }
  } else if (finalScore >= 7) {
    sd.priority       = "MEDIUM";
    sd.recommendation = "REVIEW";
  } else if (finalScore >= 4) {
    sd.priority       = "LOW";
    sd.recommendation = "DEFER";
  } else {
    sd.priority       = "DECLINE";
    sd.recommendation = "DECLINE";
  }

  const noDocumentation = sE <= 1;
  const weakLiability   = sL <= 1;
  const hasVagueDefendant = isVagueDefendant;

  let serverGapCount = 0;
  if (!answers.partiesInvolved?.trim() || hasVagueDefendant)              serverGapCount++;
  if (sE === 0)                                                              serverGapCount++;
  if (!answers.injuriesDamages?.trim() || sD === 0)                       serverGapCount++;
  if (!answers.incidentDate?.trim())                                       serverGapCount++;
  if (!answers.incidentLocation?.trim())                                   serverGapCount++;

  let confidence: "HIGH" | "MEDIUM" | "LOW";

  if (sE >= 2 && sL >= 2 && serverGapCount <= 1) {
    confidence = "HIGH";
  } else if (noDocumentation || weakLiability || serverGapCount >= 3) {
    confidence = "LOW";
  } else {
    confidence = "MEDIUM";
  }

  if (hasVagueDefendant && confidence === "HIGH") {
    confidence = "MEDIUM";
    console.warn("[server] DECISION CONFIDENCE downgraded HIGH→MEDIUM: vague defendant.");
  }
  if (sE === 0 && confidence !== "LOW") {
    confidence = "LOW";
    console.warn("[server] DECISION CONFIDENCE downgraded to LOW: zero evidence score.");
  }

  sd.decisionConfidence = confidence;

  if (typeof parsed.attorneyReport === "string") {
    parsed.attorneyReport = (parsed.attorneyReport as string).replace(
      /DECISION CONFIDENCE:\s*(HIGH|MEDIUM|LOW|\[HIGH \/ MEDIUM \/ LOW\])/i,
      `DECISION CONFIDENCE: ${confidence}`
    );
  }

  let calibrationNotes: string[] = [];

  if (sE <= 1 && (sd.score as number) > 6) {
    const excess = (sd.score as number) - 6;
    console.warn(`[server] CALIBRATION: Evidence ≤ 1 — total score capped from ${sd.score} to 6.`);
    const dims: Array<{ key: "scoreDamages"|"scoreLiability"|"scoreClientReadiness"; val: number }> = [
      { key: "scoreDamages",         val: sD },
      { key: "scoreLiability",       val: sL },
      { key: "scoreClientReadiness", val: sC },
    ].sort((a, b) => b.val - a.val);
    let remaining = excess;
    for (const dim of dims) {
      if (remaining <= 0) break;
      const cut = Math.min(dim.val, remaining);
      (sd as Record<string, unknown>)[dim.key] = dim.val - cut;
      remaining -= cut;
    }
    sD = sd.scoreDamages as number;
    sL = sd.scoreLiability as number;
    sC = sd.scoreClientReadiness as number;
    sd.score = sE + sD + sL + sC;
    calibrationNotes.push("Score limited due to lack of supporting evidence despite detailed account — total score capped at 6.");
  }

  if (isVagueDefendant && (sd.scoreLiability as number) > 1) {
    console.warn(`[server] CALIBRATION: No named defendant — scoreLiability re-capped to 1.`);
    sL = 1;
    sd.scoreLiability = 1;
    sd.score = sE + sD + sL + sC;
    calibrationNotes.push("Liability score capped at 1 — no named or identified defendant. Liability cannot be established without an opposing party.");
  }

  const noWitnessMentioned = !String(answers.additionalNotes || "").toLowerCase().includes("witness") &&
                              !String(answers.caseType || "").toLowerCase().includes("witness") &&
                              !String(answers.injuriesDamages || "").toLowerCase().includes("witness");
  const noDocMentioned = sE === 0 ||
    (!String(answers.injuriesDamages || "").match(/record|report|photo|video|bill|receipt|contract|document|email|text|message|footage/i) &&
     !String(answers.caseType || "").match(/record|report|photo|video|bill|receipt|contract|document|email|text|message|footage/i) &&
     !String(answers.additionalNotes || "").match(/record|report|photo|video|bill|receipt|contract|document|email|text|message|footage/i));

  if (noDocMentioned && noWitnessMentioned && (sd.scoreEvidence as number) > 1) {
    console.warn(`[server] CALIBRATION: No documentation or witnesses detected — scoreEvidence capped from ${sd.scoreEvidence} to 1.`);
    const prevE = sd.scoreEvidence as number;
    sE = 1;
    sd.scoreEvidence = 1;
    sd.score = sE + sD + sL + sC;
    calibrationNotes.push(`Evidence score reduced from ${prevE} to 1 — no documentation or witnesses confirmed. Narrative account alone cannot substantiate evidence score above 1.`);
  }

  sd.score = (sd.scoreEvidence as number) + (sd.scoreDamages as number) + (sd.scoreLiability as number) + (sd.scoreClientReadiness as number);
  const calibratedScore = sd.score as number;

  if (calibratedScore >= 10 && !isVagueDefendant) {
    sd.priority = "HIGH"; sd.recommendation = "ACCEPT";
  } else if (calibratedScore >= 10 && isVagueDefendant) {
    sd.priority = "MEDIUM"; sd.recommendation = "REVIEW";
  } else if (calibratedScore >= 7) {
    sd.priority = "MEDIUM"; sd.recommendation = "REVIEW";
  } else if (calibratedScore >= 4) {
    sd.priority = "LOW"; sd.recommendation = "DEFER";
  } else {
    sd.priority = "DECLINE"; sd.recommendation = "DECLINE";
  }

  if (calibrationNotes.length > 0 && sd.decisionConfidence === "HIGH") {
    sd.decisionConfidence = "MEDIUM";
    console.warn("[server] CALIBRATION: Decision Confidence downgraded HIGH→MEDIUM due to score calibration.");
    calibrationNotes.push("Decision Confidence reduced to MEDIUM — score calibration applied due to insufficient verified evidence.");
  }
  if ((sd.scoreEvidence as number) <= 1 && sd.decisionConfidence === "HIGH") {
    sd.decisionConfidence = "LOW";
    console.warn("[server] CALIBRATION: Decision Confidence downgraded HIGH→LOW: evidence ≤ 1.");
  }

  if (calibrationNotes.length > 0 && typeof parsed.attorneyReport === "string") {
    const calibrationBlock = `\nCALIBRATION APPLIED:\n${calibrationNotes.map((n) => `- ${n}`).join("\n")}\n`;
    parsed.attorneyReport = (parsed.attorneyReport as string).replace(
      /(CRITICAL GAPS:[\s\S]*?)(━+)/,
      `$1${calibrationBlock}\n$2`
    );
    parsed.attorneyReport = (parsed.attorneyReport as string).replace(
      /DECISION CONFIDENCE:\s*(HIGH|MEDIUM|LOW|\[HIGH \/ MEDIUM \/ LOW\])/i,
      `DECISION CONFIDENCE: ${sd.decisionConfidence}`
    );
  }

  res.json(parsed);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[server] LIRU Report Generation error:", message);
  res.status(500).json({ error: "Failed to generate report", detail: message });
}
});

  // ── Email Delivery Route ──────────────────────────────────────────────────
  app.post("/api/intake", async (req, res) => {
    if (!process.env.RESEND_API_KEY) {
      console.error("[server] RESEND_API_KEY is not set in .env");
      res.status(500).json({ error: "Server misconfiguration: missing RESEND_API_KEY" });
      return;
    }

    const { structuredData, attorneyReport } = req.body;

    if (!structuredData || !attorneyReport) {
      res.status(400).json({ error: "Missing required fields: structuredData and attorneyReport" });
      return;
    }

    if (typeof attorneyReport !== "string" || attorneyReport.trim().length < 10) {
      res.status(400).json({ error: "Invalid attorneyReport: must be a non-empty string" });
      return;
    }

    try {
      if (process.env.RESEND_API_KEY === "TEST_KEY") {
        console.log("[server] TEST_KEY — skipping email.");
        res.status(200).json({ success: true, id: "test-id-" + Date.now() });
        return;
      }

      const resend = new Resend(process.env.RESEND_API_KEY);

      const priority = String(structuredData.priority || "UNKNOWN").toUpperCase();
      const recommendation = String(structuredData.recommendation || "REVIEW").toUpperCase();
      const score = structuredData.score ?? "—";

      const priorityColors: Record<string, string> = {
        HIGH: "#dc2626", MEDIUM: "#d97706", LOW: "#6b7280", DECLINE: "#475569",
      };
      const recColors: Record<string, string> = {
        ACCEPT: "#16a34a", REVIEW: "#d97706", DEFER: "#6b7280", DECLINE: "#dc2626",
      };

      const pc = priorityColors[priority] || "#64748b";
      const rc = recColors[recommendation] || "#64748b";

      const dims = [
        { label: "Evidence", key: "scoreEvidence" },
        { label: "Damages", key: "scoreDamages" },
        { label: "Liability Clarity", key: "scoreLiability" },
        { label: "Client Readiness", key: "scoreClientReadiness" },
      ];

      const dimHtml = dims.map((d) => {
        const val = Number(structuredData[d.key] ?? 0);
        const pct = Math.round((val / 3) * 100);
        const c = val >= 2 ? "#16a34a" : val === 1 ? "#d97706" : "#dc2626";
        return `<div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
            <span style="font-size:11px;color:#94a3b8;font-family:'Courier New',monospace;">${d.label}</span>
            <span style="font-size:12px;font-weight:bold;color:${c};font-family:'Courier New',monospace;">${val}/3</span>
          </div>
          <div style="background:#0f172a;height:4px;border-radius:2px;overflow:hidden;">
            <div style="background:${c};height:100%;width:${pct}%;border-radius:2px;"></div>
          </div>
        </div>`;
      }).join("");

      const flagsHtml = Array.isArray(structuredData.redFlags) && structuredData.redFlags.length > 0
        ? structuredData.redFlags.map((f: string) =>
            `<div style="display:flex;gap:8px;margin-bottom:6px;align-items:flex-start;">
              <span style="color:#dc2626;font-size:11px;margin-top:1px;flex-shrink:0;">▲</span>
              <span style="font-size:12px;color:#fca5a5;font-family:'Courier New',monospace;line-height:1.5;">${f}</span>
            </div>`
          ).join("")
        : `<span style="font-size:12px;color:#4ade80;font-family:'Courier New',monospace;">None identified.</span>`;

      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: "support@smrgconsulting.com",
        subject: `[${recommendation}] ${structuredData.fullName || "Unknown"} | Score: ${score}/12 | ${priority} Priority`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:'Courier New',monospace;background:#0f172a;color:#e2e8f0;margin:0;padding:24px;">
<div style="max-width:680px;margin:0 auto;background:#1e293b;border:1px solid #334155;border-radius:6px;overflow:hidden;">

  <div style="background:#0f172a;padding:20px 24px;border-bottom:2px solid ${rc};">
    <div style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:3px;margin-bottom:10px;">Fortress Legal Systems — Attorney Eyes Only</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-size:22px;font-weight:900;color:#f1f5f9;">${structuredData.fullName || "Unknown"}</div>
        <div style="font-size:12px;color:#64748b;margin-top:3px;">${structuredData.contactInfo || "—"}</div>
      </div>
      <div style="background:${rc}18;border:1px solid ${rc}44;border-radius:5px;padding:12px 18px;text-align:center;min-width:100px;">
        <div style="font-size:9px;color:${rc};text-transform:uppercase;letter-spacing:3px;margin-bottom:4px;">Decision</div>
        <div style="font-size:18px;font-weight:900;color:${rc};letter-spacing:2px;">${recommendation}</div>
      </div>
    </div>
  </div>

  <div style="padding:20px 24px;border-bottom:1px solid #334155;display:flex;gap:32px;flex-wrap:wrap;align-items:flex-start;">
    <div style="min-width:100px;">
      <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:2px;margin-bottom:4px;">Readiness Score</div>
      <div style="font-size:44px;font-weight:900;color:${pc};line-height:1;">${score}<span style="font-size:16px;color:#334155;">/12</span></div>
      <div style="margin-top:8px;display:inline-block;background:${pc}18;color:${pc};border:1px solid ${pc}44;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:2px;padding:3px 10px;border-radius:3px;">${priority} Priority</div>
    </div>
    <div style="flex:1;min-width:200px;">${dimHtml}</div>
  </div>

  <div style="padding:16px 24px;border-bottom:1px solid #334155;background:#dc262608;">
    <div style="font-size:9px;color:#dc2626;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:bold;">⚠ RED FLAGS</div>
    ${flagsHtml}
  </div>

  <div style="padding:20px 24px;border-bottom:1px solid #334155;">
    <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;">Full Triage Report</div>
    <pre style="white-space:pre-wrap;font-size:11px;color:#cbd5e1;line-height:1.7;margin:0;background:#0f172a;padding:16px;border-radius:4px;border:1px solid #1e293b;overflow-x:auto;">${attorneyReport}</pre>
  </div>

  <div style="padding:16px 24px;">
    <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;">Structured Intake Data</div>
    <pre style="white-space:pre-wrap;font-size:10px;color:#475569;line-height:1.5;margin:0;background:#0f172a;padding:14px;border-radius:4px;border:1px solid #1e293b;overflow-x:auto;">${JSON.stringify(structuredData, null, 2)}</pre>
  </div>

  <div style="padding:10px 24px;background:#0f172a;border-top:1px solid #1e293b;">
    <div style="font-size:9px;color:#1e293b;text-align:center;">Fortress Legal Systems v4.0 — ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</div>
  </div>

</div>
</body></html>`,
      });

      res.status(200).json({ success: true });
    } catch (err) {
      console.error("[server] Unexpected error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Vite dev middleware ───────────────────────────────────────────────────
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });

  app.use(vite.middlewares);

  app.listen(PORT, () => {
    console.log(`\n   ✅   LIRU Dev server running at http://localhost:${PORT}\n`);
  });
}

main().catch((err) => {
  console.error("Failed to start dev server:", err);
  process.exit(1);
});
