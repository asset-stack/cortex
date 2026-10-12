import { useStore } from '@/data/store';
import { ALLOWED_DOMAIN } from '@/data/backend/client';
import { Avatar } from '@/components/ui';
import { LEVELS, MODULES, ROLES, ROLE_LABELS, STAFF_DEFAULTS, roleOf, useAccess } from '@/lib/access';
import { cn } from '@/lib/cn';
import { Switch } from './controls';

const MODULE_LABELS = { projects: 'Projects', marketing: 'Marketing', outreach: 'Outreach', pipeline: 'Pipeline', clients: 'Clients' };
const LEVEL_LABELS = { none: 'None', view: 'View', edit: 'Edit' };

// A staff member's level for a module as stored: their override, else the staff default. (moduleLevel() would say
// 'none' for an inactive person; the grid shows what they get back when switched on again.)
function storedLevel(state, userId, module) {
  const o = (state.moduleAccess || []).find((x) => x.userId === userId && x.module === module);
  return o && LEVELS.includes(o.level) ? o.level : STAFF_DEFAULTS[module];
}

/** None / View / Edit for one module; the staff default carries a dot. */
function LevelPicker({ module, who, value, onChange, readOnly }) {
  const name = MODULE_LABELS[module] || module;
  return (
    <div className="flex items-center justify-between gap-3 rounded-[16px] bg-white/5 py-1.5 pl-3 pr-1.5">
      <span className="truncate text-[13px] font-semibold">{name}</span>
      <div role="group" aria-label={`${name} access for ${who}`} className="inline-flex shrink-0 rounded-full border border-white/20 bg-white/10 p-0.5 text-[12.5px]">
        {LEVELS.map((l) => {
          const on = value === l;
          const def = STAFF_DEFAULTS[module] === l;
          return (
            <button key={l} type="button" aria-pressed={on} disabled={readOnly} title={def ? 'Staff default' : undefined}
              onClick={() => { if (!on) onChange(l); }}
              className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1', on ? 'chip-on font-semibold' : 'dim', !on && !readOnly && 'hover:bg-white/15')}>
              {LEVEL_LABELS[l]}
              {def && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
              {def && <span className="sr-only"> (default)</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Roles, active flags and staff module access are the SuperAdmin's (the store and RLS check the same); admins see
// them read-only. Your own row is locked, so nobody demotes or deactivates themselves.
export default function Team() {
  const { state, actions } = useStore();
  const { isSuper } = useAccess();
  return (
    <div className="rounded-[26px] glass glass-rim p-2 sm:p-3">
      <ul>
        {state.users.map((u) => {
          const self = u.id === state.me;
          const active = u.active !== false;
          const role = roleOf(state, u.id);
          const editable = isSuper && !self;
          return (
            <li key={u.id} className="border-b rowline p-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className={cn('flex min-w-0 flex-1 basis-[220px] items-center gap-3', !active && 'opacity-60')}>
                  <Avatar userId={u.id} size={36} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-semibold"><span className="truncate">{u.name}</span>
                      {self && <span className="rounded-full chip px-2 py-0.5 text-[11px]">You</span>}</div>
                    <div className="text-[12.5px] dimmer truncate">{u.email || '—'}</div>
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-4">
                  {editable ? (
                    <select className="field !w-auto !rounded-full !py-1.5" aria-label={`Role for ${u.name}`} value={role}
                      onChange={(e) => actions.updateProfile(u.id, { role: e.target.value })}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  ) : (
                    <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[12.5px] font-semibold">
                      <span className="sr-only">Role: </span>{ROLE_LABELS[role] || ROLE_LABELS.staff}
                    </span>
                  )}
                  <span className="flex items-center gap-2 text-[12.5px] dim">Active
                    <Switch checked={active} disabled={!editable} label={`${u.name} active`} onChange={(v) => actions.updateProfile(u.id, { active: v })} />
                  </span>
                </div>
              </div>
              {role === 'staff' && (
                <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(250px,100%),1fr))] gap-2 sm:pl-12">
                  {MODULES.map((m) => (
                    <LevelPicker key={m} module={m} who={u.name} value={storedLevel(state, u.id, m)} readOnly={!isSuper}
                      onChange={(level) => actions.setModuleAccess(u.id, m, level)} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="px-3 pb-2 pt-1 text-[12px] dimmer">Staff join by signing in with their @{ALLOWED_DOMAIN} Google account.</p>
    </div>
  );
}
