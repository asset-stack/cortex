// Gmail integration seam (stubbed).
// TODO(backend): replace with calls to a server endpoint (e.g. a Cloudflare Worker) that holds the
// Google OAuth client and the staff member's refresh token. Never put Google secrets in this frontend.
//   GET  /api/gmail/threads?label=crm               -> listThreads()
//   POST /api/gmail/send {to, subject, body}         -> sendEmail()
//   POST /api/gmail/send-invoice {clientId, invoiceId} -> sendInvoice() (the server renders the PDF)

export const GMAIL_CONNECTED = false;

export async function listThreads() {
  return { connected: GMAIL_CONNECTED, threads: [] };
}

export async function sendEmail({ to, subject, body }) {
  // Simulated: the caller logs the email to the activity feed. Nothing leaves the browser.
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, simulated: true, to, subject, length: body.length };
}

// Approving an invoice sends it with this once Gmail is connected. Until then nothing is sent: the invoice stays
// Approved and the PDF goes out by hand ("Mark as sent").
export async function sendInvoice({ client, invoice } = {}) {
  if (!GMAIL_CONNECTED || !client || !invoice) return { sent: false };
  return { sent: false }; // TODO(backend): POST /api/gmail/send-invoice { clientId: client.id, invoiceId: invoice.id }
}
