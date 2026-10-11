// Claude outreach agent seam (stubbed with templates).
// TODO(backend): POST /api/agent/draft {contact, goal, history} to a server that calls the
// Anthropic Messages API with the AssetStack voice guide and the contact's CRM history.
// The Anthropic API key must live on the server, never in this bundle.

// `org` is trimmed and may be empty (contacts can be added without one), so each template has a fallback.
const TEMPLATES = {
  'Book follow-up demo': (org) =>
    `Thanks again for your time. I'd like to show you how ${org || 'your team'} could see every asset, condition rating and renewal date in one place, using your own data.\n\nWould 30 minutes next Tuesday or Thursday suit?`,
  'Send capability statement': (org) =>
    `As promised, our capability statement is attached. It covers asset registers, inspections and capital planning for organisations like ${org || 'yours'}.\n\nHappy to walk your team through any section.`,
  'Re-engage': (org) =>
    `Is asset management still on the agenda for ${org || 'your team'} this quarter? If timing has shifted, I'm happy to follow up later in the year.`,
};

export const GOALS = Object.keys(TEMPLATES);

export async function draftOutreach({ contact, goal, sender }) {
  await new Promise((r) => setTimeout(r, 650));
  const org = (contact.org || '').trim();
  const first = contact.name.trim().split(/\s+/)[0];
  return {
    subject: {
      'Book follow-up demo': org ? `Follow-up demo for ${org}` : 'Follow-up demo',
      'Send capability statement': 'AssetStack capability statement',
      'Re-engage': org ? `Checking in – ${org}` : 'Checking in',
    }[goal],
    body: `Hi ${first},\n\n${TEMPLATES[goal](org)}\n\nKind regards,\n${sender}\nAssetStack · assetstackai.com`,
    simulated: true,
  };
}
