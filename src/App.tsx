import { useState } from "react";
import { ChatComponent } from "./ChatComponent";

export type Message = {
  id: string;
  role: "user" | "model" | "system";
  text: string;
};

export type SubmitStatus = "idle" | "submitting" | "success" | "error";
export type Language = "en" | "es";

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

const INTAKE_QUESTIONS: Record<Language, { phase: number; field: string; question: string }[]> = {
  en: [
    {
      phase: 1,
      field: "fullName",
      question: "Welcome to the RRU™ Real Estate Matchmaker! I'll ask a few quick questions to match you with the right properties and agent. To start — what's your **name**?",
    },
    {
      phase: 2,
      field: "contactInfo",
      question: "Thanks! What's the best **phone number and/or email** to reach you at?",
    },
    {
      phase: 3,
      field: "buyingGoal",
      question: "Are you looking to buy a primary home, invest, relocate, purchase a second home, or explore commercial property — or just exploring the market for now?",
    },
    {
      phase: 4,
      field: "location",
      question: "Got it. What **cities, neighborhoods, or zip codes** are you primarily interested in?",
    },
    {
      phase: 5,
      field: "budget",
      question: "What's your approximate **target price or budget range**?",
    },
    {
      phase: 6,
      field: "mortgageStatus",
      question: "Have you already spoken to a lender and been **pre-approved**, or will you be purchasing with cash?",
    },
    {
      phase: 7,
      field: "downPayment",
      question: "Roughly how much are you planning to put towards a **down payment**?",
    },
    {
      phase: 8,
      field: "timeline",
      question: "What's your **ideal timeline** to move or close? (e.g., immediately, 3 months, next year)",
    },
    {
      phase: 9,
      field: "currentHomeSituation",
      question: "What's your current housing situation — **renting, own your home, living with family**, a lease ending soon, or do you need to sell your current home first?",
    },
    {
      phase: 10,
      field: "mustHaves",
      question: "What are your **must-haves** for a new property? (e.g., bedrooms, bathrooms, yard, parking, school district)",
    },
    {
      phase: 11,
      field: "obstacles",
      question: "Last one — is anything **holding you back** right now, like credit concerns, saving for a down payment, finding the right property, or needing to sell your current home first?",
    },
  ],
  es: [
    {
      phase: 1,
      field: "fullName",
      question: "¡Bienvenido al Agente inmobiliario RRU™! Haré algunas preguntas rápidas para relacionarle con las propiedades y el agente adecuados. Para empezar, ¿cuál es su **nombre**?",
    },
    {
      phase: 2,
      field: "contactInfo",
      question: "¡Gracias! ¿Cuál es el mejor **número de teléfono y/o correo electrónico** para comunicarnos con usted?",
    },
    {
      phase: 3,
      field: "buyingGoal",
      question: "¿Busca comprar una vivienda principal, invertir, mudarse, comprar una segunda vivienda o explorar propiedades comerciales, o solo está explorando el mercado por ahora?",
    },
    {
      phase: 4,
      field: "location",
      question: "Entendido. ¿Qué **ciudades, vecindarios o códigos postales** le interesan principalmente?",
    },
    {
      phase: 5,
      field: "budget",
      question: "¿Cuál es su **precio objetivo o rango de presupuesto** aproximado?",
    },
    {
      phase: 6,
      field: "mortgageStatus",
      question: "¿Ya ha hablado con un prestamista y ha sido **preaprobado**, o comprará al contado?",
    },
    {
      phase: 7,
      field: "downPayment",
      question: "¿Cuánto planea aportar aproximadamente para el **pago inicial**?",
    },
    {
      phase: 8,
      field: "timeline",
      question: "¿Cuál es su **plazo ideal** para mudarse o cerrar? (ej., inmediatamente, 3 meses, el próximo año)",
    },
    {
      phase: 9,
      field: "currentHomeSituation",
      question: "¿Cuál es su situación de vivienda actual — **alquila, posee su casa, vive con su familia**, se le acaba el contrato pronto, o necesita vender su casa actual primero?",
    },
    {
      phase: 10,
      field: "mustHaves",
      question: "¿Cuáles son sus **requisitos indispensables** para una nueva propiedad? (ej., habitaciones, baños, patio, estacionamiento, distrito escolar)",
    },
    {
      phase: 11,
      field: "obstacles",
      question: "Última pregunta — ¿hay algo que **le esté deteniendo** en este momento, como problemas de crédito, ahorro para el pago inicial, encontrar la propiedad adecuada o necesitar vender primero?",
    },
  ]
};

const ROADMAP_TITLES: Record<Language, string[]> = {
  en: ["Name", "Contact", "Buying Goal", "Location", "Budget", "Financing", "Down Payment", "Timeline", "Current Home", "Must-Haves", "Obstacles"],
  es: ["Nombre", "Contacto", "Meta", "Ubicación", "Presupuesto", "Financiamiento", "Pago Inicial", "Plazo", "Vivienda", "Requisitos", "Obstáculos"]
};

const ALL_FIELDS = [
  { key: "fullName",             label: "Full Name",             critical: true  },
  { key: "contactInfo",          label: "Contact Information",    critical: true  },
  { key: "buyingGoal",           label: "Buying Goal",            critical: true  },
  { key: "location",             label: "Target Location",        critical: false },
  { key: "budget",               label: "Target Budget",          critical: false },
  { key: "mortgageStatus",       label: "Financing Status",       critical: false },
  { key: "downPayment",          label: "Down Payment",           critical: false },
  { key: "timeline",             label: "Timeline",               critical: false },
  { key: "currentHomeSituation", label: "Current Home Situation", critical: false },
  { key: "mustHaves",            label: "Must-Haves",             critical: false },
  { key: "obstacles",            label: "Obstacles & Concerns",   critical: false },
];

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

function validateInputPreflight(phase: number, text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "A response is required before continuing.";
  if (t.length > 4000) return "Your response exceeds the character limit. Please summarize.";

  if (phase === 1 && t.length < 2) {
    return "Please share at least your first name so we know what to call you.";
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
    "SECTION 1: BUYER IDENTIFICATION",
    `   Full Name:    ${answers.fullName             || "Not provided"}`,
    `   Contact:      ${answers.contactInfo          || "Not provided"}`,
    "",
    "SECTION 2: PURCHASE GOALS",
    `   Goal:         ${answers.buyingGoal           || "Not provided"}`,
    `   Location:     ${answers.location             || "Not provided"}`,
    `   Must-Haves:   ${answers.mustHaves            || "Not provided"}`,
    "",
    "SECTION 3: FINANCIAL READINESS",
    `   Budget:       ${answers.budget               || "Not provided"}`,
    `   Financing:    ${answers.mortgageStatus       || "Not provided"}`,
    `   Down Payment: ${answers.downPayment          || "Not provided"}`,
    "",
    "SECTION 4: TIMELINE, HOUSING & OBSTACLES",
    `   Timeline:     ${answers.timeline             || "Not provided"}`,
    `   Current Home: ${answers.currentHomeSituation || "Not provided"}`,
    `   Obstacles:    ${answers.obstacles            || "Not provided"}`,
  ].join("\n");
}

async function fetchWithEvaluateRetry(url: string, options: RequestInit, retries = 1, delay = 2000): Promise<Response> {
  try {
    const response = await fetch(url, options);
    if (response.status === 503 && retries > 0) {
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

export default function App() {
  const [language, setLanguage] = useState<Language>("en");
  const questionsList = INTAKE_QUESTIONS[language];

  const [messages, setMessages] = useState<Message[]>([
    { id: "init", role: "model", text: INTAKE_QUESTIONS.en[0].question },
  ]);
  const [isLoading,       setIsLoading]   = useState(false);
  const [isFinished,      setIsFinished]  = useState(false);
  const [currentPhase,    setCurrentPhase] = useState(1);
  const [answers,         setAnswers]     = useState<Record<string, string>>({});
  const [submitStatus,    setSubmitStatus] = useState<SubmitStatus>("idle");
  const [finalScore,      setFinalScore]  = useState<StructuredData | null>(null);
  const [preflightFailCount, setPreflightFailCount] = useState(0);
  const PREFLIGHT_BYPASS_THRESHOLD = 2;
  const [lastAssistantMessage, setLastAssistantMessage] = useState(INTAKE_QUESTIONS.en[0].question);

  const handleLanguageChange = (newLang: Language) => {
    if (currentPhase > 1 || isFinished) return;
    setLanguage(newLang);
    setMessages([{ id: "init", role: "model", text: INTAKE_QUESTIONS[newLang][0].question }]);
    setLastAssistantMessage(INTAKE_QUESTIONS[newLang][0].question);
  };

  const addMessage = (role: Message["role"], text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, text },
    ]);
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() || isLoading || isFinished || currentPhase > questionsList.length) return;

    const currentQuestion = questionsList[currentPhase - 1];
    addMessage("user", text);

    const preflightError = validateInputPreflight(currentPhase, text);
    if (preflightError && preflightFailCount < PREFLIGHT_BYPASS_THRESHOLD) {
      setPreflightFailCount((n) => n + 1);
      addMessage("model", preflightError);
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetchWithEvaluateRetry("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase:      currentPhase,
          question:   lastAssistantMessage,
          answer:     text.trim(),
          allAnswers: answers,
          language:   language,
        }),
      });

      if (!response.ok) throw new Error(`Evaluation API returned ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      addMessage("model", data.agentResponse || (language === "es" ? "¿Podría compartir un poco más?" : "Could you share a bit more?"));

      const isValid = toBool(data.isValid);
      const hasExtractedData = typeof data.extractedData === "string" && data.extractedData.trim().length > 0;
      const inconsistencyDetected = toBool(data.inconsistencyDetected);
      const followUpTriggered = toBool(data.followUpTriggered);

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

        if (nextPhase <= questionsList.length) {
          setCurrentPhase(nextPhase);
          const agentAlreadyAskedSomething = /\?\s*$/.test(String(data.agentResponse || "").trim());
          if (!agentAlreadyAskedSomething) {
            const nextQuestion = questionsList[nextPhase - 1];
            setLastAssistantMessage(nextQuestion.question);
            setTimeout(() => {
              addMessage("model", nextQuestion.question);
            }, 450);
          } else {
            setLastAssistantMessage(String(data.agentResponse));
          }
        } else {
          setCurrentPhase(questionsList.length + 1);
          setTimeout(() => {
            addMessage(
              "system",
              language === "es"
                ? "¡Todo listo! Por favor revise sus respuestas abajo. Cuando esté listo, haga clic en **Enviar perfil**."
                : "All done! Please review your answers below. When you're ready, click **Submit Profile**."
            );
          }, 450);
        }
      } else {
        setLastAssistantMessage(String(data.agentResponse || currentQuestion.question));
      }
    } catch (err) {
      console.error("[App] Evaluation error:", err);
      addMessage("model", language === "es" ? "Ocurrió un error al evaluar su respuesta. Intente de nuevo." : "A system error occurred. Please try again.");
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
      addMessage("system", `⚠️ Required fields empty: ${criticalMissing.join(", ")}.`);
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
      } catch {
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
        addMessage("system", language === "es" ? "✅ ¡Perfil de comprador enviado con éxito!" : "✅ Your buyer profile has been successfully submitted!");
      } else {
        setSubmitStatus("error");
        addMessage("system", language === "es" ? "❌ Error al enviar. Intente de nuevo." : "❌ Submission failed. Please try again.");
      }
    } catch {
      setSubmitStatus("error");
      addMessage("system", language === "es" ? "❌ Ocurrió un error de red." : "❌ A network error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  const roadmapTitles = ROADMAP_TITLES[language];
  const progressPct =
    isFinished || currentPhase > questionsList.length
      ? 100
      : Math.round(((currentPhase - 1) / questionsList.length) * 100);

  const agentPriorityColors: Record<string, string> = {
    "A+": "text-emerald-400",
    "A":  "text-emerald-400",
    "B":  "text-sky-400",
    "C":  "text-amber-400",
    "D":  "text-slate-400",
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden flex-col md:flex-row">
      
      {/* MOBILE HEADER BAR WITH LANGUAGE TOGGLE */}
      <div className="md:hidden bg-slate-900 text-white px-4 py-3 flex items-center justify-between border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
          <span className="font-bold tracking-tight uppercase text-xs">
            RRU™ Matchmaker
          </span>
        </div>
        {currentPhase === 1 && !isFinished && (
          <div className="flex gap-1 bg-slate-800 p-1 rounded">
            <button
              onClick={() => handleLanguageChange("en")}
              className={`px-2.5 py-1 text-[11px] font-mono rounded ${language === "en" ? "bg-indigo-600 text-white font-bold" : "text-slate-400"}`}
            >
              EN
            </button>
            <button
              onClick={() => handleLanguageChange("es")}
              className={`px-2.5 py-1 text-[11px] font-mono rounded ${language === "es" ? "bg-indigo-600 text-white font-bold" : "text-slate-400"}`}
            >
              ES
            </button>
          </div>
        )}
      </div>

      {/* DESKTOP SIDEBAR */}
      <aside className="hidden md:flex w-72 bg-slate-900 text-slate-300 flex-col border-r border-slate-800 shrink-0">
        <div className="p-6 border-b border-slate-800 flex justify-between items-center">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
              <h1 className="font-bold text-white tracking-tight uppercase text-sm">
                RRU™ Matchmaker
              </h1>
            </div>
            <p className="text-[10px] text-slate-600 font-mono uppercase tracking-widest">
              {language === "es" ? "Bilingüe / Gold" : "Buyer Qualification v1.0"}
            </p>
          </div>
          {currentPhase === 1 && !isFinished && (
            <div className="flex gap-1 bg-slate-800 p-1 rounded">
              <button
                onClick={() => handleLanguageChange("en")}
                className={`px-2 py-0.5 text-[10px] font-mono rounded ${language === "en" ? "bg-indigo-600 text-white font-bold" : "text-slate-400"}`}
              >
                EN
              </button>
              <button
                onClick={() => handleLanguageChange("es")}
                className={`px-2 py-0.5 text-[10px] font-mono rounded ${language === "es" ? "bg-indigo-600 text-white font-bold" : "text-slate-400"}`}
              >
                ES
              </button>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-0.5">
          <div className="text-[10px] font-bold text-slate-600 uppercase px-2 py-2 tracking-widest">
            {language === "es" ? "Protocolo de 11 Fases" : "11-Phase Protocol"}
          </div>
          {roadmapTitles.map((title, idx) => {
            const stepNum = idx + 1;
            const isActive = currentPhase === stepNum;
            const isCompleted = currentPhase > stepNum || isFinished;
            return (
              <div
                key={stepNum}
                className={`flex items-center gap-3 px-3 py-2 text-xs transition-colors rounded ${
                  isActive ? "bg-slate-800 text-white" : isCompleted ? "text-slate-400" : "text-slate-600 opacity-40"
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
                  {isCompleted && !isActive ? "✓" : stepNum.toString().padStart(2, "0")}
                </span>
                <span className="font-mono">{title}</span>
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
          </div>
        )}

        {!finalScore && (
          <div className="p-4 border-t border-slate-800 bg-slate-900/50 shrink-0">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[10px] uppercase font-bold text-slate-600 tracking-widest">Progress</span>
              <span className="text-[10px] font-mono text-slate-400">{progressPct}%</span>
            </div>
            <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
              <div className="bg-indigo-600 h-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
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
          showReview={currentPhase > questionsList.length}
          intakeQuestions={questionsList}
          allFields={ALL_FIELDS}
        />
      </main>
    </div>
  );
}