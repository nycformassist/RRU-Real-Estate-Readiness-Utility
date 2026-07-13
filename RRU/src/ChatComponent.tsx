import React, { useState, useRef, useEffect } from "react";
import { Message, SubmitStatus } from "./App";
import ReactMarkdown from "react-markdown";
import { CheckCircle2, AlertCircle, AlertTriangle } from "lucide-react";

interface IntakeQuestion {
  field: string;
  question: string;
  phase: number;
}

interface FieldMeta {
  key: string;
  label: string;
  critical: boolean;
}

interface ChatComponentProps {
  messages: Message[];
  onSendMessage: (text: string) => void;
  onFinish: () => void;
  isLoading: boolean;
  isFinished: boolean;
  submitStatus?: SubmitStatus;
  answers?: Record<string, string>;
  onEditAnswer?: (field: string, newValue: string) => void;
  showReview?: boolean;
  intakeQuestions?: IntakeQuestion[];
  allFields?: FieldMeta[];
}

// ── Strip internal phase markers ─────────────────────────────────────────────
function cleanMessageText(text: string): string {
  return text.replace(/^\[PHASE:\s*\d+\]\s*/i, "").trim();
}

// ── Detect error/warning system messages ─────────────────────────────────────
function isErrorMessage(text: string): boolean {
  return text.startsWith("❌") || text.startsWith("⚠️");
}

export function ChatComponent({
  messages,
  onSendMessage,
  onFinish,
  isLoading,
  isFinished,
  submitStatus,
  answers,
  onEditAnswer,
  showReview,
  intakeQuestions,
  allFields,
}: ChatComponentProps) {
  const [inputValue, setInputValue] = useState("");
  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (endOfMessagesRef.current) {
      endOfMessagesRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading, showReview]);

  useEffect(() => {
    if (!isLoading && !isFinished && !showReview && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading, isFinished, showReview]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed || isLoading || isFinished || submitStatus === "submitting") return;
    onSendMessage(trimmed);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const isInputDisabled =
    isLoading || isFinished || submitStatus === "submitting" || showReview;

  const reviewFields = allFields || (intakeQuestions || []).map((q) => ({
    key: q.field,
    label: q.field.replace(/([A-Z])/g, " $1").trim(),
    critical: ["fullName", "contactInfo", "buyingGoal"].includes(q.field),
  }));

  const emptyCount = answers
    ? reviewFields.filter((f) => !answers[f.key]?.trim()).length
    : 0;

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 relative">

      {/* Header - Rebranded to RRU™ */}
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 md:px-8 z-10 shrink-0">
        <div className="flex items-center gap-4">
          <div className="px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-[10px] font-bold uppercase tracking-wider">
            RRU™ Online
          </div>
          <div className="h-4 w-px bg-slate-200 hidden sm:block" />
          <span className="text-sm font-medium text-slate-600 underline underline-offset-4 decoration-indigo-500 hidden sm:inline">
            Automated Property & Buyer Qualification
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-white">
            CL
          </div>
          <span className="text-xs font-semibold hidden sm:inline text-slate-700">Client</span>
        </div>
      </header>

      {/* Messages */}
      <section className="flex-1 overflow-y-auto p-4 md:p-8 flex flex-col gap-4 min-h-0">
        {messages.map((msg) => {
          const displayText = msg.role === "model" ? cleanMessageText(msg.text) : msg.text;

          if (msg.role === "system") {
            const isError = isErrorMessage(displayText);
            return (
              <div key={msg.id} className="self-center mx-auto max-w-2xl w-full px-2">
                <div
                  className={`flex items-start gap-2.5 text-xs font-medium px-4 py-2.5 rounded-lg border ${
                    isError
                      ? "text-red-700 bg-red-50 border-red-200"
                      : "text-slate-600 bg-slate-100 border-slate-200"
                  }`}
                >
                  {isError
                    ? <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                    : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                  }
                  <ReactMarkdown
                    components={{
                      p: ({ ...props }) => <p className="m-0 leading-relaxed" {...props} />,
                      strong: ({ ...props }) => <strong className="font-bold" {...props} />,
                    }}
                  >
                    {displayText}
                  </ReactMarkdown>
                </div>
              </div>
            );
          }

          return (
            <div
              key={msg.id}
              className={`flex gap-3 max-w-2xl ${
                msg.role === "user" ? "self-end flex-row-reverse" : "self-start"
              }`}
            >
              <div
                className={`w-8 h-8 rounded flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white ${
                  msg.role === "user" ? "bg-blue-600" : "bg-slate-900"
                }`}
              >
                {/* Avatar Initial changed to RRU for Real Estate Readiness Utility */}
                {msg.role === "user" ? "CL" : "RRU"}
              </div>
              <div
                className={`p-4 rounded-xl shadow-sm max-w-[calc(100%-3rem)] ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-white border border-slate-200 text-slate-800 rounded-tl-sm"
                }`}
              >
                {msg.role === "model" ? (
                  <ReactMarkdown
                    components={{
                      p: ({ ...props }) => (
                        <p className="text-sm leading-relaxed text-slate-800 m-0 pb-2 last:pb-0" {...props} />
                      ),
                      strong: ({ ...props }) => (
                        <strong className="font-semibold text-slate-900" {...props} />
                      ),
                    }}
                  >
                    {displayText}
                  </ReactMarkdown>
                ) : (
                  <p className="text-sm leading-relaxed text-white m-0 whitespace-pre-wrap">
                    {displayText}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {/* Loading indicator - Rebranded */}
        {(isLoading || submitStatus === "submitting") && (
          <div className="flex gap-3 max-w-2xl self-start">
            <div className="w-8 h-8 rounded bg-slate-900 flex-shrink-0 flex items-center justify-center">
              <span className="text-[10px] font-bold text-white">RRU</span>
            </div>
            <div className="bg-white border border-slate-200 p-4 rounded-xl rounded-tl-sm shadow-sm flex items-center gap-3">
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-[11px] text-slate-400 font-medium italic">
                {submitStatus === "submitting"
                  ? "Finalizing secure buyer match report..."
                  : "RRU™ is analyzing..."}
              </span>
            </div>
          </div>
        )}

        {showReview && answers && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-3xl self-center mx-auto w-full mt-2 mb-2">
            <div className="flex items-center gap-2 mb-2 pb-3 border-b border-slate-100">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
                Review Your Buyer Profile
              </h3>
            </div>
            
            {/* Dynamic Review Table */}
            <div className="mt-4 space-y-3">
              {reviewFields.map((field) => {
                const answer = answers[field.key] || "";
                return (
                  <div key={field.key} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 py-2 border-b border-slate-50 last:border-0">
                    <div className="sm:w-48 text-xs font-semibold text-slate-500 uppercase tracking-wider shrink-0 mt-0.5">
                      {field.label}
                      {field.critical && <span className="text-red-400 ml-1" title="Required">*</span>}
                    </div>
                    <div className="flex-1">
                      {answer ? (
                        <div className="text-sm text-slate-800 whitespace-pre-wrap">{answer}</div>
                      ) : (
                        <div className="text-sm text-slate-400 italic">Not provided</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-[10px] text-slate-400 italic">
                By submitting, you confirm the above information is accurate. This will be securely reviewed by our real estate team.
              </p>
              <button
                type="button"
                onClick={onFinish}
                disabled={isLoading || isFinished || submitStatus === "submitting" || emptyCount > 0}
                className="px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg uppercase tracking-widest disabled:opacity-50 transition-colors shadow-sm whitespace-nowrap"
              >
                {isFinished ? "✅ Submitted" : "Submit Profile →"}
              </button>
            </div>
          </div>
        )}

        <div ref={endOfMessagesRef} className="h-2 shrink-0" />
      </section>

      {/* Input Footer */}
      <footer className="p-4 md:p-5 bg-white border-t border-slate-200 shrink-0">
        <form onSubmit={handleSubmit} className="flex items-center gap-3">
          <div
            className={`flex-1 flex bg-slate-50 border rounded-lg overflow-hidden transition-all ${
              isInputDisabled
                ? "border-slate-200 opacity-60"
                : "border-slate-300 focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-transparent"
            }`}
          >
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isInputDisabled}
              placeholder={
                isFinished ? "Interview complete." : "Type your response here..."
              }
              className="flex-1 bg-transparent px-4 py-3 text-sm outline-none disabled:cursor-not-allowed"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={!inputValue.trim() || isInputDisabled}
              className="px-5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </div>
        </form>
        <div className="mt-2.5 flex justify-between items-center">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-medium uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
            Real Estate Readiness Protocol
          </div>
          <span className="text-[10px] text-slate-300">RRU™ Engine v1.0</span>
        </div>
      </footer>
    </div>
  );
}
