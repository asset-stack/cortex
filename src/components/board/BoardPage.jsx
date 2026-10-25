import { useEffect, useState } from 'react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { BOARD_SCHEMAS } from '@/data/boards';
import { MODULE_HOMES, boardHref, resolveBoard } from '@/lib/boards';
import { hashParam } from '@/lib/router';
import { PageHeader } from '@/components/ui';
import Board from './Board';
import NewBoardModal from './NewBoard';

/**
 * A module's board: the one #/<module>/<sub> names, else the module's default (its first team board; for Projects with
 * none you can see, your own page). Outreach and Clients have none: #/<module> is their own page (MODULE_HOMES), where a board
 * of theirs that's gone leads back.
 */
export default function BoardPage({ module, sub }) {
  const { state } = useStore();
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  const item = hashParam('item');
  const visible = (state.boards || []).filter(access.canViewBoard);
  const board = resolveBoard(state, visible, module, sub, item);
  const id = board?.id;

  // The address always names the board on screen: #/marketing (the default), a board you can't see or that was deleted,
  // and an old task link (#/projects?item=…) are all replaced by the board shown, so reordering or adding boards
  // elsewhere never swaps it under you. location.replace adds no history entry and, unlike replaceState, fires the
  // hashchange useRoute listens for.
  useEffect(() => {
    if (id && sub !== id) window.location.replace(boardHref({ module, id }, item || undefined));
    else if (!id && MODULE_HOMES[module]) window.location.replace(MODULE_HOMES[module].href);
  }, [module, sub, id, item]);

  if (!board && MODULE_HOMES[module]) return null;
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
