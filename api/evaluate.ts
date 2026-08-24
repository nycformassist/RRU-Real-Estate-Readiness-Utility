import { generateJSON } from "../lib/gemini-client.js";
import { 
  buildEvaluateSystemInstruction, 
  detectBuyerMode, 
  EVALUATE_RESPONSE_SCHEMA 
} from "../lib/constants.js";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { phase, answer, allAnswers } = body;

    // Detect the buyer mode dynamically from previous answers (Defaults to STANDARD)
    const mode = detectBuyerMode(allAnswers?.buyingGoal || "");

    // Use your original powerhouse instruction builder to get language, follow-up, and mode logic
    const systemPrompt = buildEvaluateSystemInstruction(phase, mode, "en");

    const userPrompt = `
PREVIOUSLY COLLECTED DATA:
${JSON.stringify(allAnswers, null, 2)}

CURRENT PHASE: ${phase}
CLIENT'S ANSWER: "${answer}"
    `;

    // Generate response using your strict EVALUATE_RESPONSE_SCHEMA and the correct generateJSON function
    const aiResponse = await generateJSON(systemPrompt, userPrompt, EVALUATE_RESPONSE_SCHEMA);
    
    // Clean and parse the output
    const cleanJson = aiResponse.replace(/```json\n?|```/g, "").trim();
    const result = JSON.parse(cleanJson);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[Evaluate API] Error:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
  }
}