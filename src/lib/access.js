// Roles and module access (docs/PHASE2.md §1). The store checks these before every edit and screens read them
// through useAccess(); RLS (public.module_level / can_view / can_edit in 0002) is the real enforcement and uses the
// same rules. The helpers are pure, so scripts/test-sync.mjs runs them in Node.
import { useMemo } from 'react';
import { useStore } from '@/data/store';

export const ROLES = ['superadmin', 'admin', 'staff'];
export const ROLE_LABELS = { superadmin: 'SuperAdmin', admin: 'Admin', staff: 'Staff' };
export const LEVELS = ['none', 'view', 'edit'];
export const MODULES = ['projects', 'marketing', 'outreach', 'pipeline', 'clients'];
// What staff get without an override. Admins always have edit.
export const STAFF_DEFAULTS = { projects: 'edit', marketing: 'edit', outreach: 'none', pipeline: 'view', clients: 'view' };

const userOf = (state, userId) => (state?.users || []).find((u) => u.id === userId);
const isActive = (u) => Boolean(u) && u.active !== false;

// The user's role; phase 1's 'member' (or anything unknown) reads as 'staff', and '' means no such user.
export function roleOf(state, userId = state?.me) {
  const u = userOf(state, userId);
  if (!u) return '';
  return ROLES.includes(u.role) ? u.role : 'staff';
}

export const isAdminRole = (role) => role === 'superadmin' || role === 'admin';

// Active admin or superadmin (is_admin() in SQL).
export function isAdmin(state, userId = state?.me) {
  return isActive(userOf(state, userId)) && isAdminRole(roleOf(state, userId));
}

// Active superadmin (is_superadmin() in SQL): the only one who changes roles, active flags and module access.
export function isSuperadmin(state, userId = state?.me) {
  return isActive(userOf(state, userId)) && roleOf(state, userId) === 'superadmin';
}

// 'none' | 'view' | 'edit': admins edit everything; staff get their override, else the default. Inactive or unknown
// users and unknown modules get 'none'.
export function moduleLevel(state, module, userId = state?.me) {
  const u = userOf(state, userId);
  if (!isActive(u) || !MODULES.includes(module)) return 'none';
  if (isAdminRole(roleOf(state, userId))) return 'edit';
  const override = (state.moduleAccess || []).find((x) => x.userId === userId && x.module === module);
  return override && LEVELS.includes(override.level) ? override.level : STAFF_DEFAULTS[module];
}

export const canView = (state, module, userId) => moduleLevel(state, module, userId) !== 'none';
export const canEdit = (state, module, userId) => moduleLevel(state, module, userId) === 'edit';

// Whose personal Projects page `userId` may open (sees_person() in 0006): their own; staff's for admins; everyone's
// for the SuperAdmin.
export function seesPerson(state, ownerId, userId = state?.me) {
  if (!isActive(userOf(state, userId)) || !ownerId) return false;
  if (ownerId === userId || isSuperadmin(state, userId)) return true;
  return isAdmin(state, userId) && roleOf(state, ownerId) === 'staff';
}

// 'none' | 'view' | 'edit' on a board (board_level() in 0006): a team board has its module's level; a personal board
// (board.owner set) is 'edit' for whoever may open it while they can see Projects at all, else 'none'.
export function boardLevel(state, board, userId = state?.me) {
  if (!board || !MODULES.includes(board.module)) return 'none';
  if (!board.owner) return moduleLevel(state, board.module, userId);
  return canView(state, board.module, userId) && seesPerson(state, board.owner, userId) ? 'edit' : 'none';
}

export const canViewBoard = (state, board, userId) => boardLevel(state, board, userId) !== 'none';
export const canEditBoard = (state, board, userId) => boardLevel(state, board, userId) === 'edit';

// The signed-in user's access, for screens: hide modules at none, render read-only at view.
export function useAccess() {
  const { state } = useStore();
  return useMemo(() => ({
    role: roleOf(state),
    isAdmin: isAdmin(state),
    isSuper: isSuperadmin(state),
    level: (module) => moduleLevel(state, module),
    canView: (module) => canView(state, module),
    canEdit: (module) => canEdit(state, module),
    seesPerson: (userId) => seesPerson(state, userId),
    canViewBoard: (board) => canViewBoard(state, board),
    canEditBoard: (board) => canEditBoard(state, board),
  }), [state]);
}
