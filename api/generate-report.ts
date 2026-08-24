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

    // Call Gemini using robust generateJSON helper with fallback logic
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

    // Format the precise RRU email dashboard report
    const attorneyReport = [
      `RRU™ AI BUYER QUALIFICATION & READINESS ENGINE`,
      `Generated: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `BUYER READINESS SCORE: ${structuredData.score ?? "N/A"} / 100  |  TIER: ${structuredData.readinessBand || "Unknown"}`,
      `AGENT PRIORITY SCORE:  ${structuredData.agentPriority || "D"}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `AI BUYER SUMMARY:`,
      parsedReport.buyerSummary || "No summary provided.",
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `QUALIFICATION METRICS:`,
      `  Financing Readiness:    ${structuredData.financingReadiness || "Unknown"}`,
      `  Motivation Index:       ${structuredData.buyerMotivationIndex || "Unknown"}`,
      `  Purchase Timeline:      ${structuredData.purchaseTimeline || "Unknown"}`,
      `  Buying Power:           ${structuredData.buyingPower || "Unknown"}`,
      `  Property Match:         ${structuredData.propertyMatch || "Unknown"}`,
      ``,
      `DECISION RISK FLAGS:`,
      ...(structuredData.redFlags && structuredData.redFlags.length > 0 
          ? structuredData.redFlags.map((flag: string) => `  - ${flag}`) 
          : ["  - None identified."]),
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `RECOMMENDED NEXT STEP:`,
      `  >>> ${structuredData.recommendedNextStep || "Review Profile"} <<<`
    ].join("\n");

    return new Response(
      JSON.stringify({ structuredData, attorneyReport }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("[Report API Error Critical]:", error.message);
    // Return a 500 error so it stops the email from sending blank data
    return new Response(
      JSON.stringify({ error: error.message || "Failed to generate report structure." }), 
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}