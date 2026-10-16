import { useEffect, useState } from 'react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { BOARD_SCHEMAS } from '@/data/boards';
import { boardHref, resolveBoard } from '@/lib/boards';
import { hashParam } from '@/lib/router';
import { PageHeader } from '@/components/ui';
import Board from './Board';
import NewBoardModal from './NewBoard';

/** Projects / Marketing: the board #/<module>/<sub> names, else the module's default (your own page for Projects). */
export default function BoardPage({ module, sub }) {
  const { state } = useStore();
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  const item = hashParam('item');
  const visible = (state.boards || []).filter(access.canViewBoard);
  const board = resolveBoard(state, visible, module, sub, item);
  const id = board?.id;

  // A board you can't see (or one that was deleted) shows the default, and an old task link (#/projects?item=…) shows
  // the board holding the task: put that board in the address so closing the task or a re-render keeps it.
  // location.replace adds no history entry and, unlike replaceState, fires the hashchange useRoute listens for.
  useEffect(() => {
    if (id && sub !== id && (sub || item)) window.location.replace(boardHref({ module, id }, item || undefined));
  }, [module, sub, id, item]);

  if (!board) {
    return (
      <div>
        <PageHeader title={BOARD_SCHEMAS[module]?.title} action={access.isAdmin ? 'New board' : undefined} onAction={() => setAdding(true)} />
        {!access.isAdmin && <p className="mt-6 dim">No boards yet.</p>}
        {adding && <NewBoardModal module={module} onClose={() => setAdding(false)} />}
      </div>
    );
  }
  return <Board key={board.id} board={board} />;
}
