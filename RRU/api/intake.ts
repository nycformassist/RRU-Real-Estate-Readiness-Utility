import type { VercelRequest, VercelResponse } from "@vercel/node";
import sgMail from "@sendgrid/mail";

// Ensure the API Key is set
const sendgridApiKey = process.env.SENDGRID_API_KEY;
if (sendgridApiKey) {
  sgMail.setApiKey(sendgridApiKey);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Method Enforcement
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 2. Validate environment
  if (!sendgridApiKey) {
    console.error("[intake] SENDGRID_API_KEY is missing");
    return res.status(500).json({ error: "Server configuration error" });
  }

  // 3. Extract and Validate body
  const { structuredData, attorneyReport } = req.body;
  if (!structuredData || !attorneyReport) {
    return res.status(400).json({ error: "Missing required payload fields" });
  }

  try {
    const msg = {
      to: "your-broker-email@example.com", // Ensure this matches your SendGrid verified sender
      from: "noreply@yourdomain.com",       // Must be a verified sender in SendGrid
      subject: `New RRU™ Buyer Lead: ${structuredData.fullName}`,
      text: `A new buyer has completed the RRU™ intake process.\n\nPriority: ${structuredData.priority}\n\nReport:\n${attorneyReport}`,
      html: `
        <h1>New RRU™ Buyer Lead</h1>
        <p><strong>Name:</strong> ${structuredData.fullName}</p>
        <p><strong>Priority:</strong> ${structuredData.priority}</p>
        <div style="background:#f4f4f4; padding:10px;">
            <pre style="white-space:pre-wrap;">${attorneyReport}</pre>
        </div>
      `,
    };

    await sgMail.send(msg);
    return res.status(200).json({ success: true });
    
  } catch (error: any) {
    // SendGrid specific error logging
    if (error.response) {
      console.error("SendGrid API Error Details:", error.response.body);
    } else {
      console.error("General Error:", error);
    }
    return res.status(500).json({ success: false, error: "Failed to send email" });
  }
}
