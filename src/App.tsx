import { useState } from "react";
import { ChatComponent } from "./ChatComponent";

export type Message = {
  id: string;
  role: "user" | "model" | "system";
  text: string;
};

export type SubmitStatus = "idle" | "submitting" | "success" | "error";

// Matches the actual output of /api/generate-report (see lib/constants.ts
// buildReportSystemInstruction + api/generate-report.ts's server-side
// validation). This used to drift from the backend's real schema — keep
// it in sync whenever generate-report.ts's structuredData shape changes.
export type StructuredData = {
  fullName: string;
  contactInfo: string;
  buyingGoal: string;
  buyerMode?: string;
  buyerModeLabel?: string;
  clientLanguage?: string;
  location: string;
  budget: string;
  mortgageStatus: string;
  downPayment: string;
  timeline: string;
  currentHomeSituation?: string;
  mustHaves: string;
  obstacles: string;

  scoreFinancialReadiness?: number;
  scoreMotivation?: number;
  scoreTimeline?: number;
  scorePropertyClarity?: number;
  scoreFinancingStatus?: number;
  scoreDecisionAuthority?: number;
  scoreDocumentation?: number;
  score?: number;

  readinessBand?: "Elite Buyer" | "Ready Buyer" | "Qualified" | "Warm Lead" | "Long-Term Prospect" | "Educational Nurture";
  agentPriority?: "A+" | "A" | "B" | "C" | "D";
  financingReadiness?: "Excellent" | "Good" | "Needs Work" | "Unknown";
  motivationIndex?: "Very High" | "High" | "Moderate" | "Low" | "Shopping Only";
  purchaseTimeline?: string;

  propertyMatch?: string[];
  estimatedBudget?: string;
  estimatedDownPayment?: string;
  estimatedMonthlyPayment?: string;
  loanRange?: string;

  recommendedNextStep?: string;
  riskFlags?: string[];
  submittedAt?: string;
};

// ── Intake question definitions ──────────────────────────────────────────────
// 11 phases, one topic at a time — no bundled "name + phone + email"
// opener. Field keys line up 1:1 with lib/constants.ts's PHASE_RULES and
// with what api/generate-report.ts reads off `answers`.
const INTAKE_QUESTIONS = [
  {
    phase: 1,
    field: "fullName",
    question:
      "Welcome to the RRU™ Real Estate Matchmaker! I'll ask a few quick questions to match you with the right properties and agent. To start — what's your **name**?",
  },
  {
    phase: 2,
    field: "contactInfo",
    question:
      "Thanks! What's the best **phone number and/or email** to reach you at?",
  },
  {
    phase: 3,
    field: "buyingGoal",
    question:
      "Are you looking to buy a primary home, invest, relocate, purchase a second home, or explore commercial property — or just exploring the market for now?",
  },
  {
    phase: 4,
    field: "location",
    question:
      "Got it. What **cities, neighborhoods, or zip codes** are you primarily interested in?",
  },
  {
    phase: 5,
    field: "budget",
    question:
      "What's your approximate **target price or budget range**?",
  },
  {
    phase: 6,
    field: "mortgageStatus",
    question:
      "Have you already spoken to a lender and been **pre-approved**, or will you be purchasing with cash?",
  },
  {
    phase: 7,
    field: "downPayment",
    question:
      "Roughly how much are you planning to put towards a **down payment**?",
  },
  {
    phase: 8,
    field: "timeline",
    question:
      "What's your **ideal timeline** to move or close? (e.g., immediately, 3 months, next year)",
  },
  {
    phase: 9,
    field: "currentHomeSituation",
    question:
      "What's your current housing situation — **renting, own your home, living with family**, a lease ending soon, or do you need to sell your current home first?",
  },
  {
    phase: 10,
    field: "mustHaves",
    question:
      "What are your **must-haves** for a new property? (e.g., bedrooms, bathrooms, yard, parking, school district)",
  },
  {
    phase: 11,
    field: "obstacles",
    question:
      "Last one — is anything **holding you back** right now, like credit concerns, saving for a down payment, finding the right property, or needing to sell your current home first?",
  },
];

// ── All fields for submission guard ──────────────────────────────────────────
const ALL_FIELDS: { key: string; label: string; critical: boolean }[] = [
  { key: "fullName",            label: "Full Name",              critical: true  },
  { key: "contactInfo",         label: "Contact Information",    critical: true  },
  { key: "buyingGoal",          label: "Buying Goal",            critical: true  },
  { key: "location",            label: "Target Location",        critical: false },
  { key: "budget",              label: "Target Budget",          critical: false },
  { key: "mortgageStatus",      label: "Financing Status",       critical: false },
  { key: "downPayment",         label: "Down Payment",           critical: false },
  { key: "timeline",            label: "Timeline",               critical: false },
  { key: "currentHomeSituation", label: "Current Home Situation", critical: false },
  { key: "mustHaves",           label: "Must-Haves",             critical: false },
  { key: "obstacles",           label: "Obstacles & Concerns",   critical: false },
];

// ── Defensive boolean coercion ───────────────────────────────────────────────
// Mirrors the same helper in api/evaluate.ts. The backend guarantees real
// booleans via EVALUATE_RESPONSE_SCHEMA, but this stays as a second line
// of defense against transport quirks or a future API change.
function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

// ── Client-side preflight validation ─────────────────────────────────────────
// Deliberately light-touch: only Name and Contact get a hard local check
// (they have an unambiguous shape). Every other phase's "did they actually
// answer" judgment is left to /api/evaluate, which has the real phase
// rule and pushback script — a client-side regex can't tell "I'm just
// looking" (a valid Phase 3 answer) from a true non-answer.
function validateInputPreflight(phase: number, text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "A response is required before continuing.";
  if (t.length > 4000) return "Your response exceeds the character limit. Please summarize.";

  if (phase === 1) {
    if (t.length < 2) {
      return "Please share at least your first name so we know what to call you.";
    }
  }

  if (phase === 2) {
    const hasEmail = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(t);
    const digitCount = (t.match(/\d/g) || []).length;
    if (!hasEmail && digitCount < 7) {
      return "Please provide a valid phone number (at least 7 digits) or a valid email address.";
    }
  }

  return null;
}

// ── Fallback data builders (used only if /api/generate-report is unreachable) ─
function buildStructuredDataFallback(answers: Record<string, string>): StructuredData {
  return {
    fullName:             answers.fullName             || "",
    contactInfo:          answers.contactInfo          || "",
    buyingGoal:           answers.buyingGoal           || "",
    location:             answers.location             || "",
    budget:               answers.budget               || "",
    mortgageStatus:       answers.mortgageStatus       || "",
    downPayment:          answers.downPayment          || "",
    timeline:             answers.timeline             || "",
    currentHomeSituation: answers.currentHomeSituation || "",
    mustHaves:            answers.mustHaves            || "",
    obstacles:            answers.obstacles            || "",
    score: 0,
    readinessBand: "Educational Nurture",
    agentPriority: "D",
    financingReadiness: "Unknown",
    motivationIndex: "Shopping Only",
    riskFlags: ["SYSTEM: Manual agent review and scoring required — report generation failed."],
    recommendedNextStep: "Follow Up in 90 Days",
    submittedAt: new Date().toISOString(),
  };
}

function buildFallbackBuyerSummary(answers: Record<string, string>): string {
  return [
    "RRU™ REAL ESTATE MATCHMAKER — CONFIDENTIAL BUYER PROFILE",
    `Generated: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "PROFILE STATUS: MANUAL REVIEW REQUIRED",
    "BUYER READINESS SCORE: N/A / 100  |  AGENT PRIORITY: D",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "NOTE: Automated scoring failed. Raw intake data is preserved below for",
    "manual agent review before any matching or outreach.",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "SECTION 1: BUYER IDENTIFICATION",
    `  Full Name:    ${answers.fullName             || "Not provided"}`,
    `  Contact:      ${answers.contactInfo          || "Not provided"}`,
    "",
    "SECTION 2: PURCHASE GOALS",
    `  Goal:         ${answers.buyingGoal           || "Not provided"}`,
    `  Location:     ${answers.location             || "Not provided"}`,
    `  Must-Haves:   ${answers.mustHaves            || "Not provided"}`,
    "",
    "SECTION 3: FINANCIAL READINESS",
    `  Budget:       ${answers.budget               || "Not provided"}`,
    `  Financing:    ${answers.mortgageStatus       || "Not provided"}`,
    `  Down Payment: ${answers.downPayment          || "Not provided"}`,
    "",
    "SECTION 4: TIMELINE, HOUSING & OBSTACLES",
    `  Timeline:     ${answers.timeline             || "Not provided"}`,
    `  Current Home: ${answers.currentHomeSituation || "Not provided"}`,
    `  Obstacles:    ${answers.obstacles            || "Not provided"}`,
    "",
    "SECTION 5: AGENT RECOMMENDATION",
    "  Recommended Next Step: Follow Up in 90 Days (pending manual review)",
    "  Agent must manually evaluate this profile before making any representation decisions.",
  ].join("\n");
}

// ── Helper: Fetch with Automatic 503 Retry ────────────────────────────────────
async function fetchWithEvaluateRetry(url: string, options: RequestInit, retries = 1, delay = 2000): Promise<Response> {
  try {
    const response = await fetch(url, options);

    if (response.status === 503 && retries > 0) {
      console.warn(`[App] Received 503 from API. Auto-retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithEvaluateRetry(url, options, retries - 1, delay);
    }

    return response;
  } catch (error) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithEvaluateRetry(url, options, retries - 1, delay);
    }
    throw error;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "init",
      role: "model",
      text: INTAKE_QUESTIONS[0].question,
    },
  ]);
  const [isLoading,     setIsLoading]   = useState(false);
  const [isFinished,    setIsFinished]  = useState(false);
  const [currentPhase, setCurrentPhase] = useState(1);
  const [answers,      setAnswers]     = useState<Record<string, string>>({});
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [finalScore,   setFinalScore]  = useState<StructuredData | null>(null);
  // Tracks consecutive *local* preflight rejections for the current phase.
  // If the client-side regex/length checks reject the same phase 2+ times
  // in a row, we stop trusting them and send straight to the AI instead —
  // this is the "never permanently trapped" escape hatch. Resets to 0
  // whenever the phase advances.
  const [preflightFailCount, setPreflightFailCount] = useState(0);
  const PREFLIGHT_BYPASS_THRESHOLD = 2;
  // The exact text of the last question the client actually saw — the
  // base phase question initially, but after that it may be a pushback
  // script's question, a dynamic follow-up question, or a consistency
  // confirmation, none of which match INTAKE_QUESTIONS[currentPhase-1].
  // This is what gets sent to /api/evaluate as "question" so the backend
  // grades the answer against what was REALLY asked — sending the static
  // phase text unconditionally was the root cause of RRU accepting
  // off-topic answers (e.g. a location) as if they'd answered a
  // follow-up about investment strategy, since the static phase-level
  // question reads as generically "real estate related" either way.
  const [lastAssistantMessage, setLastAssistantMessage] = useState(INTAKE_QUESTIONS[0].question);

  const addMessage = (role: Message["role"], text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, text },
    ]);
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() || isLoading || isFinished || currentPhase > INTAKE_QUESTIONS.length) return;

    const currentQuestion = INTAKE_QUESTIONS[currentPhase - 1];
    addMessage("user", text);

    const preflightError = validateInputPreflight(currentPhase, text);
    if (preflightError && preflightFailCount < PREFLIGHT_BYPASS_THRESHOLD) {
      setPreflightFailCount((n) => n + 1);
      addMessage("model", preflightError);
      return;
    }
    if (preflightError) {
      // Bypass: local validation rejected this phase twice in a row.
      // Stop trusting the lightweight client-side check and let
      // /api/evaluate decide — it has the full phase rule and pushback
      // script, so it can recognize answers the regex can't.
      console.warn(`[App] Preflight bypassed for phase ${currentPhase} after ${preflightFailCount} local rejections.`);
    }

    setIsLoading(true);

    try {
      const response = await fetchWithEvaluateRetry("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase:       currentPhase,
          question:    lastAssistantMessage,
          answer:      text.trim(),
          allAnswers:  answers,
        }),
      });

      if (!response.ok) throw new Error(`Evaluation API returned ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      addMessage(
        "model",
        data.agentResponse || "Your response doesn't quite meet what's needed for this step — could you share a bit more?"
      );

      const isValid = toBool(data.isValid);
      const hasExtractedData = typeof data.extractedData === "string" && data.extractedData.trim().length > 0;
      const inconsistencyDetected = toBool(data.inconsistencyDetected);
      const followUpTriggered = toBool(data.followUpTriggered);

      // Mirrors the server-side computation in api/evaluate.ts: advance if
      // the server explicitly says so, OR if the answer was valid with
      // real extracted data and neither hold-back flag is set.
      const shouldAdvance =
        toBool(data.advancePhase) ||
        (isValid && hasExtractedData && !inconsistencyDetected && !followUpTriggered);

      if (isValid && hasExtractedData) {
        setAnswers((prev) => ({
          ...prev,
          [currentQuestion.field]: String(data.extractedData).trim(),
        }));
      }

      if (shouldAdvance) {
        setPreflightFailCount(0);
        const nextPhase = currentPhase + 1;

        if (nextPhase <= INTAKE_QUESTIONS.length) {
          setCurrentPhase(nextPhase);
          // Ask the next question ourselves rather than hoping the
          // model's agentResponse included it — per the AGENTRESPONSE
          // CONTRACT in lib/constants.ts, agentResponse on an advancing
          // turn should be acknowledgment-only now. But models don't
          // always follow instructions perfectly, so guard against the
          // model asking a question anyway: if its agentResponse already
          // ends in "?", trust that it asked *something* and skip our
          // injection — this is exactly what caused the duplicate-
          // question problem the app previously "fixed" by removing the
          // injection entirely (which just traded one bug for the
          // silent-stall bug in the screenshot). Gating on this instead
          // of removing the injection gives both: no duplicates AND no
          // silent stalls.
          const agentAlreadyAskedSomething = /\?\s*$/.test(String(data.agentResponse || "").trim());
          if (!agentAlreadyAskedSomething) {
            const nextQuestion = INTAKE_QUESTIONS[nextPhase - 1];
            setLastAssistantMessage(nextQuestion.question);
            setTimeout(() => {
              addMessage("model", nextQuestion.question);
            }, 450);
          } else {
            // The model's acknowledgment doubled as its own question —
            // that's now the thing the client is actually replying to.
            setLastAssistantMessage(String(data.agentResponse));
          }
        } else {
          setCurrentPhase(INTAKE_QUESTIONS.length + 1);
          setTimeout(() => {
            addMessage(
              "system",
              "All done! Please review your answers below — you can edit anything before submitting. When you're ready, click **Submit Profile** to send your information to our real estate team."
            );
          }, 450);
        }
      } else {
        // Holding the phase (pushback, follow-up, inconsistency, or a
        // non-responsive answer caught by the new RELEVANCE CHECK). Per
        // the AGENTRESPONSE CONTRACT in lib/constants.ts, agentResponse
        // on a HOLD turn must itself contain the actual question the
        // client needs to answer — so that's what "last question asked"
        // means now, not the static phase text.
        setLastAssistantMessage(
          String(data.agentResponse || currentQuestion.question)
        );
      }
    } catch (err) {
      console.error("[App] Evaluation error:", err);
      addMessage("model", "A system error occurred while evaluating your response. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditAnswer = (field: string, newValue: string) => {
    if (!isFinished && submitStatus !== "submitting") {
      setAnswers((prev) => ({ ...prev, [field]: newValue }));
    }
  };

  const handleFinishInterview = async () => {
    if (isLoading || isFinished || submitStatus === "submitting") return;

    const criticalMissing = ALL_FIELDS
      .filter((f) => f.critical && !answers[f.key]?.trim())
      .map((f) => f.label);

    if (criticalMissing.length > 0) {
      addMessage(
        "system",
        `⚠️ Submission blocked: required fields are empty — ${criticalMissing.join(", ")}.`
      );
      return;
    }

    setSubmitStatus("submitting");
    setIsLoading(true);

    try {
      let structuredData: StructuredData;
      let buyerSummary: string;

      try {
        const reportRes = await fetch("/api/generate-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        });

        if (!reportRes.ok) throw new Error(`Report API returned ${reportRes.status}`);
        const generated = await reportRes.json();

        structuredData = { ...generated.structuredData, submittedAt: new Date().toISOString() };
        buyerSummary   = generated.buyerSummary;
        setFinalScore(structuredData);
      } catch (reportErr) {
        structuredData = buildStructuredDataFallback(answers);
        buyerSummary   = buildFallbackBuyerSummary(answers);
        setFinalScore(structuredData);
      }

      const intakeRes = await fetch("/api/intake", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ structuredData, buyerSummary }),
      });

      const intakeData = await intakeRes.json();

      if (intakeRes.ok && intakeData.success) {
        setIsFinished(true);
        setSubmitStatus("success");
        addMessage(
          "system",
          "✅ Your buyer profile has been successfully submitted! A real estate specialist will review your criteria and reach out shortly."
        );
      } else {
        setSubmitStatus("error");
        addMessage("system", "❌ Submission failed. Please try again.");
      }
    } catch (err: unknown) {
      setSubmitStatus("error");
      addMessage("system", "❌ A network error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const roadmapSteps = [
    { title: "Name",           phase: 1 },
    { title: "Contact",        phase: 2 },
    { title: "Buying Goal",    phase: 3 },
    { title: "Location",       phase: 4 },
    { title: "Budget",         phase: 5 },
    { title: "Financing",      phase: 6 },
    { title: "Down Payment",   phase: 7 },
    { title: "Timeline",       phase: 8 },
    { title: "Current Home",   phase: 9 },
    { title: "Must-Haves",     phase: 10 },
    { title: "Obstacles",      phase: 11 },
  ];

  const progressPct =
    isFinished || currentPhase > INTAKE_QUESTIONS.length
      ? 100
      : Math.round(((currentPhase - 1) / INTAKE_QUESTIONS.length) * 100);

  // Colored by Agent Priority (A+/A/B/C/D), matching the source spec's
  // "who should be called first tomorrow morning" scale — not the old
  // HOT/WARM/COLD/NURTURE legal-intake labels.
  const agentPriorityColors: Record<string, string> = {
    "A+": "text-emerald-400",
    "A":  "text-emerald-400",
    "B":  "text-sky-400",
    "C":  "text-amber-400",
    "D":  "text-slate-400",
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden flex-col md:flex-row">

      {/* Sidebar */}
      <aside className="hidden md:flex w-72 bg-slate-900 text-slate-300 flex-col border-r border-slate-800 shrink-0">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
            <h1 className="font-bold text-white tracking-tight uppercase text-sm">
              RRU™ Matchmaker
            </h1>
          </div>
          <p className="text-[10px] text-slate-600 font-mono uppercase tracking-widest">
            Buyer Qualification v1.0
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-0.5">
          <div className="text-[10px] font-bold text-slate-600 uppercase px-2 py-2 tracking-widest">
            11-Phase Protocol
          </div>
          {roadmapSteps.map((step) => {
            const isActive    = currentPhase === step.phase;
            const isCompleted = currentPhase > step.phase || isFinished;
            return (
              <div
                key={step.phase}
                className={`flex items-center gap-3 px-3 py-2 text-xs transition-colors rounded ${
                  isActive
                    ? "bg-slate-800 text-white"
                    : isCompleted
                    ? "text-slate-400"
                    : "text-slate-600 opacity-40"
                }`}
              >
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 font-mono ${
                    isActive
                      ? "bg-indigo-600 text-white font-bold"
                      : isCompleted
                      ? "bg-emerald-800 text-emerald-300"
                      : "border border-slate-700 text-slate-600"
                  }`}
                >
                  {isCompleted && !isActive ? "✓" : step.phase.toString().padStart(2, "0")}
                </span>
                <span className="font-mono">{step.title}</span>
              </div>
            );
          })}
        </nav>

        {finalScore && (
          <div className="p-4 border-t border-slate-800 bg-slate-900/50 shrink-0">
            <div className="text-[10px] uppercase font-bold text-slate-500 mb-3 tracking-widest">
              Match Result
            </div>
            <div className="flex items-baseline gap-1 mb-1">
              <span className={`text-3xl font-black ${agentPriorityColors[finalScore.agentPriority || "D"]}`}>
                {finalScore.score ?? "—"}
              </span>
              <span className="text-slate-600 text-sm font-mono">/100</span>
            </div>
            <div className={`text-xs font-bold uppercase tracking-widest mb-1 ${agentPriorityColors[finalScore.agentPriority || "D"]}`}>
              {finalScore.agentPriority || "—"} Priority
            </div>
            <div className="text-[11px] text-slate-500 mb-3">
              {finalScore.readinessBand || "Pending review"}
            </div>
            {finalScore.recommendedNextStep && (
              <div className="text-[10px] text-slate-500 border-t border-slate-800 pt-2">
                Next: <span className="text-slate-300">{finalScore.recommendedNextStep}</span>
              </div>
            )}
          </div>
        )}

        {!finalScore && (
          <div className="p-4 border-t border-slate-800 bg-slate-900/50 shrink-0">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[10px] uppercase font-bold text-slate-600 tracking-widest">Progress</span>
              <span className="text-[10px] font-mono text-slate-400">{progressPct}%</span>
            </div>
            <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
              <div
                className="bg-indigo-600 h-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-4 text-[10px] text-slate-700 leading-relaxed font-mono">
              All responses are confidential. Your profile will be reviewed by a licensed real estate agent.
            </div>
          </div>
        )}
      </aside>

      <main className="flex-1 flex flex-col relative min-w-0">
        <ChatComponent
          messages={messages}
          onSendMessage={handleSendMessage}
          onFinish={handleFinishInterview}
          isLoading={isLoading}
          isFinished={isFinished}
          submitStatus={submitStatus}
          answers={answers}
          onEditAnswer={handleEditAnswer}
          showReview={currentPhase > INTAKE_QUESTIONS.length}
          intakeQuestions={INTAKE_QUESTIONS}
          allFields={ALL_FIELDS}
        />
      </main>
    </div>
  );
}
