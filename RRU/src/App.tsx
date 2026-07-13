import { useState } from "react";
import { ChatComponent } from "./ChatComponent";

export type Message = {
  id: string;
  role: "user" | "model" | "system";
  text: string;
};

export type SubmitStatus = "idle" | "submitting" | "success" | "error";

export type StructuredData = {
  fullName: string;
  contactInfo: string;
  buyingGoal: string;
  location: string;
  budget: string;
  mortgageStatus: string;
  downPayment: string;
  timeline: string;
  mustHaves: string;
  obstacles: string;
  scoreFinancial?: number;
  scoreReadiness?: number;
  scoreFeasibility?: number;
  scoreClientProfile?: number;
  score?: number;
  priority?: "HOT" | "WARM" | "COLD" | "NURTURE";
  recommendation?: "VIP" | "STANDARD" | "CREDIT_REPAIR" | "NURTURE";
  redFlags?: string[];
  submittedAt?: string;
};

// ── Intake question definitions ──────────────────────────────────────────────
const INTAKE_QUESTIONS = [
  {
    phase: 1,
    field: "fullName",
    question:
      "Welcome to the RRU™ Real Estate Matchmaker. I will guide you through a brief buyer qualification interview to match you with the best properties and agents. To get started, what is your **full name**?",
  },
  {
    phase: 2,
    field: "contactInfo",
    question:
      "Thank you. What is the best **phone number and/or email address** to reach you?",
  },
  {
    phase: 3,
    field: "buyingGoal",
    question:
      "Are you currently looking to buy a primary home, invest, relocate, or are you just exploring the market right now?",
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
      "What is your approximate **target budget or price range** for this property?",
  },
  {
    phase: 6,
    field: "mortgageStatus",
    question:
      "Have you already spoken to a lender to get **pre-approved** for a mortgage, or will you be purchasing with cash?",
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
      "What is your **ideal timeline** for moving or closing on a property? (e.g., immediately, 3 months, next year)",
  },
  {
    phase: 9,
    field: "mustHaves",
    question:
      "What are the absolute **'must-haves'** for your new property? (e.g., number of bedrooms, yard, specific amenities)",
  },
  {
    phase: 10,
    field: "obstacles",
    question:
      "Finally, are there any **obstacles** holding you back right now, such as credit concerns, saving funds, or a current home you need to sell first?",
  },
];

// ── All required fields for submission guard ─────────────────────────────────
const ALL_FIELDS: { key: string; label: string; critical: boolean }[] = [
  { key: "fullName",       label: "Full Name",             critical: true  },
  { key: "contactInfo",    label: "Contact Information",   critical: true  },
  { key: "buyingGoal",     label: "Buying Goal",           critical: true  },
  { key: "location",       label: "Target Location",       critical: false },
  { key: "budget",         label: "Target Budget",         critical: false },
  { key: "mortgageStatus", label: "Financing Status",      critical: false },
  { key: "downPayment",    label: "Down Payment",          critical: false },
  { key: "timeline",       label: "Timeline",              critical: false },
  { key: "mustHaves",      label: "Must-Haves",            critical: false },
  { key: "obstacles",      label: "Obstacles & Concerns",  critical: false },
];

// ── Client-side preflight validation ─────────────────────────────────────────
function validateInputPreflight(phase: number, text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "A response is required before continuing.";
  if (t.length < 2)   return "Your response is too brief. Please provide more detail.";
  if (t.length > 4000) return "Your response exceeds the character limit. Please summarize.";

  if (phase === 1) {
    const words = t.split(/\s+/).filter((w) => w.length > 0);
    if (words.length < 2) {
      return "Please provide both your first and last name.";
    }
  }

  if (phase === 2) {
    const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
    const digitCount = (t.match(/\d/g) || []).length;
    if (!hasEmail && digitCount < 7) {
      return "Please provide a valid phone number (at least 7 digits) or a valid email address.";
    }
  }

  return null;
}

// ── Fallback data builders ────────────────────────────────────────────────────
function buildStructuredDataFallback(answers: Record<string, string>): StructuredData {
  return {
    fullName:       answers.fullName       || "",
    contactInfo:    answers.contactInfo    || "",
    buyingGoal:     answers.buyingGoal     || "",
    location:       answers.location       || "",
    budget:         answers.budget         || "",
    mortgageStatus: answers.mortgageStatus || "",
    downPayment:    answers.downPayment    || "",
    timeline:       answers.timeline       || "",
    mustHaves:      answers.mustHaves      || "",
    obstacles:      answers.obstacles      || "",
    scoreFinancial:     0,
    scoreReadiness:     0,
    scoreFeasibility:   0,
    scoreClientProfile: 0,
    score:              0,
    priority:           "NURTURE",
    recommendation:     "NURTURE",
    redFlags:           ["SYSTEM: Manual agent review and scoring required"],
    submittedAt:        new Date().toISOString(),
  };
}

function buildFallbackReport(answers: Record<string, string>): string {
  return [
    "RRU™ REAL ESTATE MATCHMAKER — CONFIDENTIAL BUYER PROFILE",
    `Generated: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "PROFILE DECISION: MANUAL REVIEW REQUIRED",
    "READINESS SCORE: N/A  |  PRIORITY: NURTURE",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "NOTE: Raw intake data is preserved below.",
    "Manual agent review and scoring required before matching.",
    "",
    "RED FLAGS:",
    "- SYSTEM ERROR: Score not calculated. Do not dispatch without manual review.",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "SECTION 1: BUYER IDENTIFICATION",
    `  Full Name:    ${answers.fullName       || "Not provided"}`,
    `  Contact:      ${answers.contactInfo    || "Not provided"}`,
    "",
    "SECTION 2: PURCHASE GOALS",
    `  Goal:         ${answers.buyingGoal     || "Not provided"}`,
    `  Location:     ${answers.location       || "Not provided"}`,
    `  Must-Haves:   ${answers.mustHaves      || "Not provided"}`,
    "",
    "SECTION 3: FINANCIAL READINESS",
    `  Budget:       ${answers.budget         || "Not provided"}`,
    `  Financing:    ${answers.mortgageStatus || "Not provided"}`,
    `  Down Payment: ${answers.downPayment    || "Not provided"}`,
    "",
    "SECTION 4: TIMELINE & OBSTACLES",
    `  Timeline:     ${answers.timeline       || "Not provided"}`,
    `  Obstacles:    ${answers.obstacles      || "Not provided"}`,
    "",
    "SECTION 5: AGENT RECOMMENDATION",
    "  Decision: NURTURE / REVIEW",
    "  Agent must manually evaluate this profile before making any representation decisions.",
  ].join("\n");
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
  const [isLoading,    setIsLoading]   = useState(false);
  const [isFinished,   setIsFinished]  = useState(false);
  const [currentPhase, setCurrentPhase] = useState(1);
  const [answers,      setAnswers]     = useState<Record<string, string>>({});
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [finalScore,   setFinalScore]  = useState<StructuredData | null>(null);

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
    if (preflightError) {
      addMessage("model", preflightError);
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase:       currentPhase,
          question:    currentQuestion.question,
          answer:      text.trim(),
          allAnswers:  answers,
        }),
      });

      if (!response.ok) throw new Error(`Evaluation API returned ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      addMessage(
        "model",
        data.agentResponse || "Your response does not meet the minimum requirements for this phase. Please provide the specific information requested."
      );

      if (data.isValid && data.extractedData) {
        setAnswers((prev) => ({
          ...prev,
          [currentQuestion.field]: String(data.extractedData).trim(),
        }));
      }

      if (data.advancePhase === true) {
        const nextPhase = currentPhase + 1;

        if (nextPhase <= INTAKE_QUESTIONS.length) {
          setCurrentPhase(nextPhase);
          const next = INTAKE_QUESTIONS[nextPhase - 1];
          setTimeout(() => addMessage("model", next.question), 350);
        } else {
          setCurrentPhase(INTAKE_QUESTIONS.length + 1);
          setTimeout(() => {
            addMessage(
              "system",
              "All 10 phases of the buyer qualification interview are complete. Please review your answers below. You may edit any field before submitting. When ready, click **Submit Profile** to send your information to our real estate team."
            );
          }, 350);
        }
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
      let attorneyReport: string;

      try {
        const reportRes = await fetch("/api/generate-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        });

        if (!reportRes.ok) throw new Error(`Report API returned ${reportRes.status}`);
        const generated = await reportRes.json();

        structuredData  = { ...generated.structuredData, submittedAt: new Date().toISOString() };
        attorneyReport  = generated.attorneyReport; // Keeping variable name consistent for your backend
        setFinalScore(structuredData);
      } catch (reportErr) {
        structuredData = buildStructuredDataFallback(answers);
        attorneyReport = buildFallbackReport(answers);
        setFinalScore(structuredData);
      }

      const intakeRes = await fetch("/api/intake", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ structuredData, attorneyReport }),
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
    { title: "Full Name",        phase: 1 },
    { title: "Contact Info",     phase: 2 },
    { title: "Buying Goal",      phase: 3 },
    { title: "Location",         phase: 4 },
    { title: "Budget",           phase: 5 },
    { title: "Financing",        phase: 6 },
    { title: "Down Payment",     phase: 7 },
    { title: "Timeline",         phase: 8 },
    { title: "Must-Haves",       phase: 9 },
    { title: "Obstacles",        phase: 10 },
  ];

  const progressPct =
    isFinished || currentPhase > INTAKE_QUESTIONS.length
      ? 100
      : Math.round(((currentPhase - 1) / INTAKE_QUESTIONS.length) * 100);

  const priorityTextColors: Record<string, string> = {
    HOT:     "text-red-400",
    WARM:    "text-amber-400",
    COLD:    "text-slate-400",
    NURTURE: "text-slate-500",
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
            10-Phase Protocol
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
              <span className={`text-3xl font-black ${priorityTextColors[finalScore.priority || "NURTURE"]}`}>
                {finalScore.score ?? "—"}
              </span>
              <span className="text-slate-600 text-sm font-mono">/12</span>
            </div>
            <div className={`text-xs font-bold uppercase tracking-widest mb-3 ${priorityTextColors[finalScore.priority || "NURTURE"]}`}>
              {finalScore.priority || "—"} Priority
            </div>
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
