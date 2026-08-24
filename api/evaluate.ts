import { generateText } from "../lib/gemini-client"; // Adjust path if needed
import { PHASE_RULES } from "../lib/constants";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { phase, question, answer, allAnswers } = body;

    const currentRule = PHASE_RULES[phase];

    if (!currentRule) {
      return new Response(JSON.stringify({ error: "Invalid phase requested." }), { status: 400 });
    }

    const systemPrompt = `
      You are an expert Real Estate Intake Assistant. 
      The user is currently in Phase ${phase} of 10.
      
      Target Field: ${currentRule.field}
      Validation Rule: ${currentRule.rule}
      
      User's Answer: "${answer}"
      
      Task: Evaluate if the user's answer satisfies the validation rule.
      
      CRITICAL INSTRUCTIONS:
      1. You MUST output ONLY valid JSON.
      2. 'isValid' MUST be a strict boolean (true or false).
      3. 'advancePhase' MUST be a strict boolean (true or false).
      4. If 'isValid' is true, 'advancePhase' MUST be true.
      5. 'extractedData' should contain the cleaned data if valid, or empty string if invalid.
      6. 'agentResponse' must be a conversational reply acknowledging the answer (if valid) and seamlessly asking the question for the next phase, OR politely asking for clarification if invalid.
      
      JSON SCHEMA:
      {
        "isValid": boolean,
        "advancePhase": boolean,
        "extractedData": "string",
        "agentResponse": "string"
      }
    `;

    const aiResponse = await generateText(systemPrompt);
    // Ensure you parse the JSON correctly from the Gemini output
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