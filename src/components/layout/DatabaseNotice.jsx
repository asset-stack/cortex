import { DatabaseZap } from 'lucide-react';
import { useStore } from '@/data/store';
import { TABLES } from '@/data/backend/schema';

/** Admins, live mode: the migrations the database is still missing (schema.js `since`). Until one runs, what it adds is
 *  off (no rows, no saving) and the rest of Cortex works as before. Nothing when every table is there. */
export default function DatabaseNotice() {
  const { missing } = useStore();
  const files = [...new Set(TABLES.filter((t) => t.since && missing.includes(t.name)).map((t) => t.since))];
  if (!files.length) return null;
  return (
    <p role="status" className="mb-4 flex items-start gap-2 rounded-2xl bg-amber-500/20 px-4 py-3 text-[13px] text-amber-50">
      <DatabaseZap className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Database update needed: run {files.map((f, i) => <span key={f}>{i ? ', ' : ''}<code className="font-semibold">{f}</code></span>)} in
        the Supabase SQL editor (DEPLOY.md section 2), then reload. Until then, what it adds is off.
      </span>
    </p>
  );
}
