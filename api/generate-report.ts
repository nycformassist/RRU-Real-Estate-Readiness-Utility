import { generateJSON } from "../lib/gemini-client.js";
import { 
  buildReportSystemInstruction, 
  detectBuyerMode 
} from "../lib/constants.js";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { answers } = body;

    if (!answers || Object.keys(answers).length === 0) {
      return new Response(JSON.stringify({ error: "No answers provided." }), { status: 400 });
    }

    const mode = detectBuyerMode(answers.buyingGoal || "");
    const systemInstruction = buildReportSystemInstruction(mode);

    const userPrompt = `
Generate the internal agent readiness report based on the following collected buyer intake answers:
${JSON.stringify(answers, null, 2)}
    `;

    // Call Gemini using your robust generateJSON helper with fallback logic
    const aiResponse = await generateJSON(systemInstruction, userPrompt);
    
    if (!aiResponse || aiResponse.trim() === "{}") {
      throw new Error("Gemini returned an empty response during report generation.");
    }

    const cleanJson = aiResponse.replace(/```json\n?|```/g, "").trim();
    const parsedReport = JSON.parse(cleanJson);
    const structuredData = parsedReport.structuredData;

    if (!structuredData) {
      throw new Error("Invalid report JSON structure returned from Gemini.");
    }

    // Format a readable text version for the email body
    const attorneyReport = [
      `RRU™ REAL ESTATE MATCHMAKER — CONFIDENTIAL BUYER PROFILE`,
      `Generated: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `PROFILE DECISION: ${structuredData.readinessBand || "REVIEW REQUIRED"}`,
      `READINESS SCORE: ${structuredData.score ?? "N/A"} / 100  |  PRIORITY: ${structuredData.agentPriority || "NURTURE"}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `BUYER SUMMARY:`,
      parsedReport.buyerSummary || "No summary provided.",
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `SECTION 1: BUYER IDENTIFICATION`,
      `  Full Name:    ${structuredData.fullName || answers.fullName || "Not provided"}`,
      `  Contact:      ${structuredData.contactInfo || answers.contactInfo || "Not provided"}`,
      `  Language:     ${structuredData.clientLanguage || "English"}`,
      ``,
      `SECTION 2: PURCHASE GOALS`,
      `  Goal:         ${structuredData.buyingGoal || answers.buyingGoal || "Not provided"}`,
      `  Location:     ${structuredData.location || answers.location || "Not provided"}`,
      `  Must-Haves:   ${structuredData.mustHaves || answers.mustHaves || "Not provided"}`,
      ``,
      `SECTION 3: FINANCIAL READINESS`,
      `  Budget:       ${structuredData.budget || answers.budget || "Not provided"}`,
      `  Financing:    ${structuredData.mortgageStatus || answers.mortgageStatus || "Not provided"}`,
      `  Down Payment: ${structuredData.downPayment || answers.downPayment || "Not provided"}`,
      ``,
      `SECTION 4: TIMELINE & OBSTACLES`,
      `  Timeline:     ${structuredData.timeline || answers.timeline || "Not provided"}`,
      `  Obstacles:    ${structuredData.obstacles || answers.obstacles || "Not provided"}`,
      ``,
      `SECTION 5: AGENT RECOMMENDATION`,
      `  Next Step:    ${structuredData.recommendedNextStep || "Review Profile"}`,
    ].join("\n");

    return new Response(
      JSON.stringify({ structuredData, attorneyReport }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("[Report API Error Critical]:", error.message);
    return new Response(
      JSON.stringify({ error: error.message || "Failed to generate report structure." }), 
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}