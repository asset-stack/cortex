import { useState } from 'react';
import { useStore } from '@/data/store';
import { PRIORITY, PRIORITY_HINTS } from '@/data/boards';
import { canEditBoard, useAccess } from '@/lib/access';
import { BOARD_MODULES, DEPARTMENTS, MODULE_LABELS, boardTitle, departmentOf, departmentValue } from '@/lib/boards';
import { hasAlso, hasClient, hasDeal, hasDepartment, hasOwner, taggable } from '@/lib/work';
import { ClientPicker, DealPicker, LabelPicker, Modal, OwnerPicker, PeoplePicker } from '@/components/ui';

/**
 * New task from anywhere (docs/PHASE2.md §18): its name, where it lives (a board you can edit, by department: team boards
 * and your own notes, not Work in Progress), its client (Clients boards), owner, priority and due date, and on a team
 * board who else is on it and its department (§20: the board's unless picked). A task made for someone else waits on
 * them to accept it. `owner` / `clientId` / `dealId` preset those (a Team page, a client, a deal's
 * next step); `modules` narrows where it can go (a client: Clients boards; a deal: Outreach boards). `title`: the
 * dialog's. Closes when it's added.
 */
export default function NewTaskModal({ onClose, owner: forOwner = '', clientId = '', dealId = '', modules = null, title = 'New task' }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const targets = state.boards.filter((b) => hasOwner(b) && access.canEditBoard(b) && (!b.owner || b.owner === state.me)
    && (!modules || modules.includes(b.module)));
  // To start with: a team board the preset owner can take on, else the first team board, else your notes.
  const first = targets.find((b) => !b.owner && (!forOwner || canEditBoard(state, b, forOwner))) || targets.find((b) => !b.owner) || targets[0];
  const [f, setF] = useState({
    name: '', board: first?.id || '', owner: forOwner || state.me, priority: 'Medium', due: '', client: clientId, deal: dealId, also: [], department: '',
  });
  const [err, setErr] = useState('');
  const board = targets.find((b) => b.id === f.board) || null;
  // Also on: teammates who can see the chosen board (not the owner); picks the new board doesn't allow drop off.
  const tag = board ? taggable(state, board, { values: { people: f.owner ? [f.owner] : [] } }) : [];
  const also = f.also.filter((id) => tag.includes(id));
  const set = (k, v) => { setErr(''); setF((x) => ({ ...x, [k]: v })); };
  const ownerName = state.users.find((u) => u.id === f.owner)?.name || '';

  const submit = (e) => {
    e.preventDefault();
    if (!f.name.trim()) { setErr('Add a name'); return; }
    if (!board) { setErr('Pick where it goes'); return; }
    if (f.owner && !canEditBoard(state, board, f.owner)) { setErr(`${ownerName} can’t edit ${boardTitle(state, board)}: pick another owner or board`); return; }
    const values = {
      owner: f.owner, priority: f.priority, due: f.due, ...(hasClient(board) ? { client: f.client } : {}), ...(hasDeal(board) ? { deal: f.deal } : {}),
      ...(hasAlso(board) ? { also } : {}),
      ...(hasDepartment(board) ? { department: departmentValue(board, f.department) } : {}),
    };
    if (!actions.addItem(board.id, null, f.name, values)) { setErr('Couldn’t add this task'); return; }
    onClose();
  };

  return (
    <Modal open onClose={onClose} title={title} width={480}>
      {targets.length === 0 ? <p className="dim">There’s no board here you can add to.</p> : (
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <input className="field" placeholder="Task" aria-label="Task" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={300} autoFocus />
          <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Where</span>
            <select className="field" value={f.board} onChange={(e) => set('board', e.target.value)}>
              {BOARD_MODULES.map((m) => targets.some((b) => b.module === m && !b.owner) && (
                <optgroup key={m} label={MODULE_LABELS[m]}>
                  {targets.filter((b) => b.module === m && !b.owner).map((b) => <option key={b.id} value={b.id}>{boardTitle(state, b)}</option>)}
                </optgroup>
              ))}
              {targets.filter((b) => b.owner).map((b) => <option key={b.id} value={b.id}>My notes</option>)}
            </select>
          </label>
          {board && hasClient(board) && (
            <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Client</span>
              <ClientPicker value={f.client} label="Client" onChange={(v) => set('client', v)} />
            </label>
          )}
          {board && hasDeal(board) && (
            <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Deal</span>
              <DealPicker value={f.deal} label="Deal" onChange={(v) => set('deal', v)} />
            </label>
          )}
          <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-end gap-3">
            <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Owner</span>
              <div className="flex h-[42px] items-center"><OwnerPicker value={f.owner ? [f.owner] : []} board={board} size={32} onChange={(v) => set('owner', v)} /></div>
            </div>
            <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Priority</span>
              <LabelPicker label="Priority" value={f.priority} options={PRIORITY} hints={PRIORITY_HINTS} onChange={(v) => set('priority', v)} className="!h-[42px]" />
            </div>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Due</span>
              <input type="date" className="field" aria-label="Due" value={f.due} onChange={(e) => set('due', e.target.value)} />
            </label>
          </div>
          {board && (hasAlso(board) || hasDepartment(board)) && (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3">
              {hasAlso(board) && (
                <div className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Also on</span>
                  <div className="flex h-[42px] items-center">
                    <PeoplePicker value={also} allow={tag} label="Also on" empty="Nobody" size={32} max={4} onChange={(v) => set('also', v)} />
                  </div>
                </div>
              )}
              {hasDepartment(board) && (
                <div className="col-start-2 flex flex-col gap-1.5"><span className="text-[12px] dimmer">Department</span>
                  <LabelPicker label="Department" value={departmentOf(board, { values: { department: f.department } })} options={DEPARTMENTS} labels={MODULE_LABELS}
                    muted={!departmentValue(board, f.department)} allowEmpty={false} className="!h-[42px]"
                    onChange={(v) => set('department', departmentValue(board, v))} />
                </div>
              )}
            </div>
          )}
          {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
          <button type="submit" className="btn-primary rounded-full h-11 font-semibold">
            {f.owner && f.owner !== state.me ? `Add for ${ownerName}` : 'Add task'}
          </button>
        </form>
      )}
    </Modal>
  );
}
