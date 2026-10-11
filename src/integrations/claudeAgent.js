// Claude outreach agent seam (stubbed with templates).
// TODO(backend): POST /api/agent/draft {contact, goal, history} to a server that calls the
// Anthropic Messages API with the AssetStack voice guide and the contact's CRM history.
// The Anthropic API key must live on the server, never in this bundle.

const TEMPLATES = {
  'Book follow-up demo': (c) =>
    `Thanks again for your time. I'd like to show you how ${c.org} could see every asset, condition rating and renewal date in one place, using your own data.\n\nWould 30 minutes next Tuesday or Thursday suit?`,
  'Send capability statement': (c) =>
    `As promised, our capability statement is attached. It covers asset registers, inspections and capital planning for organisations like ${c.org}.\n\nHappy to walk your team through any section.`,
  'Re-engage': (c) =>
    `Is asset management still on the agenda for ${c.org} this quarter? If timing has shifted, I'm happy to follow up later in the year.`,
};

export const GOALS = Object.keys(TEMPLATES);

export async function draftOutreach({ contact, goal, sender }) {
  await new Promise((r) => setTimeout(r, 650));
  const first = contact.name.split(' ')[0];
  return {
    subject: { 'Book follow-up demo': `Follow-up demo for ${contact.org}`, 'Send capability statement': 'AssetStack capability statement', 'Re-engage': `Checking in – ${contact.org}` }[goal],
    body: `Hi ${first},\n\n${TEMPLATES[goal](contact)}\n\nKind regards,\n${sender}\nAssetStack · assetstackai.com`,
    simulated: true,
  };
}
