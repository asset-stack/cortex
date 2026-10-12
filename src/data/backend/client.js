// Supabase client for live mode (docs/BACKEND.md). Without both env vars the app runs in demo mode on
// localStorage and `supabase` is null. The anon key is public by design; RLS does the protecting.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const LIVE = Boolean(url && anonKey);
export const ALLOWED_DOMAIN = 'assetstackai.com';

// PKCE: the OAuth return arrives as ?code=… and leaves the #/route hash to the router.
export const supabase = LIVE
  ? createClient(url, anonKey, { auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true } })
  : null;
