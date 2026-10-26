import { useState } from 'react';
import { useStore } from '@/data/store';
import { dropPlace } from '@/lib/boards';

// Dragging a task (desktop): its id under this type only, so nothing else (text fields, other boards' tabs) takes it.
export const DRAG_TYPE = 'application/x-cortex-task';

/**
 * Dragging a board's tasks up or down, or into another of its groups (desktop; a board's Table view and a person's task
 * cards on the Dashboard). Each call is its own drop scope: a drop only lands where its drag started, so two boards
 * (two cards, a card and an embedded board) never take each other's tasks. A drop is placed against the board's full
 * order (`groups`: the board's own, not the filtered ones shown), by dropPlace() in src/lib/boards.js.
 * → {
 *   drag (the task being dragged), over ({ group, row, place } on a row, { group, top } on the top, { group } the end),
 *   handle(itemId): props for the drag handle; row(groupId, shown, itemId), top(groupId, shown), end(groupId, shown?):
 *   drop targets (`shown`: the ids of the group's tasks on screen; end with `shown` lands after the last of them rather
 *   than at the group's very end, past hidden tasks); quiet: for the parts that take no drop; leave, endHere(groupId)
 * }
 */
export default function useTaskDrag({ boardId, groups, readOnly = false }) {
  const { actions } = useStore();
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const clear = () => { setDrag(null); setOver(null); };
  const ours = (e) => Boolean(drag) && Array.from(e.dataTransfer?.types || []).includes(DRAG_TYPE);
  const land = (spot) => {
    const id = drag;
    clear();
    const to = id ? dropPlace(groups, id, spot) : null;
    if (to) actions.placeItem(boardId, id, to.groupId, to.beforeId);
  };
  const half = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? 'before' : 'after'; };
  const hover = (e, next) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setOver((o) => (o && o.group === next.group && o.row === next.row && o.place === next.place && o.top === next.top ? o : next));
  };
  const take = (fn) => (e) => { if (!ours(e)) return; e.preventDefault(); e.stopPropagation(); fn(e); };

  const handle = (itemId) => (readOnly ? {} : {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(DRAG_TYPE, itemId);
      e.dataTransfer.effectAllowed = 'move';
      const row = e.currentTarget.closest('tr, li');
      if (row) e.dataTransfer.setDragImage(row, 24, row.offsetHeight / 2);
      // React misses dragend when the row is gone by then (moved or hidden by someone else mid-drag); the handle
      // itself still gets it.
      e.currentTarget.addEventListener('dragend', clear, { once: true });
      setDrag(itemId);
    },
    onDragEnd: clear,
  });
  const row = (groupId, shown, itemId) => (readOnly ? {} : {
    onDragOver: (e) => { if (ours(e)) hover(e, { group: groupId, row: itemId, place: half(e) }); },
    onDrop: take((e) => land({ group: groupId, shown, row: itemId, place: half(e) })),
  });
  const top = (groupId, shown) => (readOnly ? {} : {
    onDragOver: (e) => { if (ours(e)) hover(e, { group: groupId, top: true }); },
    onDrop: take(() => land({ group: groupId, shown, top: true })),
  });
  const end = (groupId, shown) => (readOnly ? {} : {
    onDragOver: (e) => { if (ours(e)) hover(e, { group: groupId }); },
    onDrop: take(() => land(shown?.length ? { group: groupId, shown, row: shown[shown.length - 1], place: 'after' } : { group: groupId, end: true })),
  });
  const quiet = drag ? () => setOver((o) => (o ? null : o)) : undefined;
  const leave = drag ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); } : undefined;
  const endHere = (groupId) => Boolean(over && over.group === groupId && !over.row && !over.top);
  return { drag, over, handle, row, top, end, quiet, leave, endHere };
}
