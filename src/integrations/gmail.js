// Gmail integration seam (stubbed).
// TODO(backend): replace with calls to a server endpoint (e.g. a Cloudflare Worker) that holds the
// Google OAuth client and the staff member's refresh token. Never put Google secrets in this frontend.
//   GET  /api/gmail/threads?label=crm      -> listThreads()
//   POST /api/gmail/send {to, subject, body} -> sendEmail()

export const GMAIL_CONNECTED = false;

export async function listThreads() {
  return { connected: GMAIL_CONNECTED, threads: [] };
}

export async function sendEmail({ to, subject, body }) {
  // Simulated: the caller logs the email to the activity feed. Nothing leaves the browser.
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, simulated: true, to, subject, length: body.length };
}
