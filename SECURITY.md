# Security policy

## Reporting a vulnerability

Please email **david@assetstackai.com** with details and steps to reproduce.
Don't open a public issue for security problems. We aim to reply within 3 business days.

## What must never be committed

This repository is public. Do not commit:

- real client names, contact details, invoices or notes (demo data uses `@example.com` placeholders);
- API keys, OAuth client secrets, tokens or `.env` files.

Gmail and Anthropic credentials belong in a server-side service (see `src/integrations/`), never in this frontend.
If a secret is committed by mistake, rotate it immediately; deleting the commit is not enough.
