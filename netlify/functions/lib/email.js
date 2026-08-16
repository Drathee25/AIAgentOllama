const { Resend } = require("resend");

async function sendItineraryEmail({ to, name, destination, pdfBuffer, fileName }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey) throw new Error("RESEND_API_KEY env var is not set");
  if (!from) throw new Error("EMAIL_FROM env var is not set");

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from,
    to,
    subject: `Your ${destination} Itinerary`,
    text: `Hi ${name || "there"},\n\nYour itinerary for ${destination} is attached as a PDF. Have a great trip!\n`,
    attachments: [
      {
        filename: fileName,
        content: pdfBuffer.toString("base64"),
      },
    ],
  });

  if (error) {
    throw new Error(`Resend send failed: ${JSON.stringify(error)}`);
  }
}

module.exports = { sendItineraryEmail };
