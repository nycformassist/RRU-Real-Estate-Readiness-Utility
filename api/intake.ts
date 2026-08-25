/**
 * api/intake.ts — POST /api/intake
 *
 * Emails the finished Buyer Readiness report to the brokerage. Uses the
 * same Vercel Node handler convention (VercelRequest/VercelResponse) as
 * api/evaluate.ts and api/generate-report.ts — a prior version of this
 * file used the Web Fetch API handler style (`export async function
 * POST(req: Request)`), which is a Next.js App Router convention this
 * project doesn't otherwise use. Mixing handler conventions across files
 * in the same api/ directory is a real deployment risk on Vercel, not
 * just a style nit.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Resend } from "resend";

let resendClient: Resend | null = null;
function getResendClient(): Resend {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set");
    }
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// Set this to your actual brokerage inbox before going live.
const NOTIFICATION_RECIPIENT = "healthcarebyvalentine@gmail.com";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("[api/intake] FATAL: RESEND_API_KEY is not set");
    res.status(500).json({ success: false, error: "Email configuration missing." });
    return;
  }

  const { structuredData, buyerSummary } = (req.body || {}) as {
    structuredData?: Record<string, unknown>;
    buyerSummary?: string;
  };

  if (!structuredData || !buyerSummary) {
    res.status(400).json({ success: false, error: "Missing required payload fields (structuredData, buyerSummary)." });
    return;
  }

  // Matches the real /api/generate-report output: "agentPriority"
  // (A+/A/B/C/D) and "readinessBand", not the legacy "priority" field.
  const agentPriority = String(structuredData.agentPriority || "D");
  const readinessBand = String(structuredData.readinessBand || "Pending Review");
  const clientName = String(structuredData.fullName || "New Lead");

  try {
    const client = getResendClient();
    const { error } = await client.emails.send({
      from: "RRU Matchmaker <onboarding@resend.dev>",
      to: [NOTIFICATION_RECIPIENT],
      subject: `[RRU™] ${agentPriority} Priority Buyer (${readinessBand}): ${clientName}`,
      text: buyerSummary,
      html: `
        <div style="font-family: monospace; white-space: pre-wrap; font-size: 14px; color: #333; background-color: #f8fafc; padding: 20px; border-radius: 8px;">
          <p><strong>Agent Priority:</strong> ${agentPriority} — ${readinessBand}</p>
          <p><strong>Recommended Next Step:</strong> ${String(structuredData.recommendedNextStep || "Review manually")}</p>
          <hr style="border-color:#e2e8f0; margin: 12px 0;" />
          ${buyerSummary}
        </div>
      `,
    });

    if (error) {
      console.error("[api/intake] Resend error:", error);
      res.status(500).json({ success: false, error: "Failed to dispatch email." });
      return;
    }

    res.status(200).json({ success: true, message: "Profile submitted and emailed successfully." });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/intake] Internal error:", message);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
}