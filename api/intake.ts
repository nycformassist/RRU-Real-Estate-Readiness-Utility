import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { structuredData, attorneyReport } = body;

    if (!process.env.RESEND_API_KEY) {
      return new Response(
        JSON.stringify({ success: false, error: "Email configuration missing." }), 
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const priority = structuredData?.priority || "NURTURE";
    const clientName = structuredData?.fullName || "New Lead";
    
    const { data, error } = await resend.emails.send({
      from: 'RRU Matchmaker <onboarding@resend.dev>', 
      to: ['healthcarebyvalentine@gmail.com'],
      subject: `[RRU Matchmaker] ${priority} Priority Buyer: ${clientName}`,
      text: attorneyReport || "No report generated.",
      html: `
        <div style="font-family: monospace; white-space: pre-wrap; font-size: 14px; color: #333; background-color: #f8fafc; padding: 20px; border-radius: 8px;">
          ${attorneyReport || "No report generated."}
        </div>
      `,
    });

    if (error) {
      console.error("[Intake API] Resend Error:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to dispatch email." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: "Profile submitted and emailed successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: "Internal Server Error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}