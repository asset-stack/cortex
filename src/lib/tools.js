// Each person's Tools in My Work (work_tools): the logins and links they use. Presets fill in the usual name, link and
// how to sign in, so an admin sets up a new starter in a few clicks. No passwords: the note says how to sign in.
// Pure (no React), so the seed and the Node tests use it.

const GOOGLE = 'Sign in with Google (your @assetstackai.com account)';

export const TOOL_PRESETS = [
  { name: 'Gmail', url: 'https://mail.google.com', how: GOOGLE },
  { name: 'Google Drive', url: 'https://drive.google.com', how: GOOGLE },
  { name: 'Google Calendar', url: 'https://calendar.google.com', how: GOOGLE },
  { name: 'Apollo', url: 'https://app.apollo.io', how: 'Sign in with Google once an admin has invited you' },
  { name: 'Claude', url: 'https://claude.ai', how: 'Continue with Google once an admin has added you to the team' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com', how: 'Your own LinkedIn login' },
];

/** A tool as stored: text trimmed (the link is kept as typed; it is checked when shown). */
export const cleanTool = (x = {}) => ({
  name: String(x.name ?? '').trim(),
  url: String(x.url ?? '').trim(),
  username: String(x.username ?? '').trim(),
  how: String(x.how ?? '').trim(),
  notes: String(x.notes ?? '').trim(),
});
