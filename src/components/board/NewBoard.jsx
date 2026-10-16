import { useState } from 'react';
import { useStore } from '@/data/store';
import { Modal } from '@/components/ui';
import { boardHref } from '@/lib/boards';

/** Admins: name a new team board for `module`, then open it. Mount it when needed (it opens on mount). */
export default function NewBoardModal({ module, onClose }) {
  const { actions } = useStore();
  const [name, setName] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const id = actions.addBoard(module, name);
    if (!id) return;
    onClose();
    window.location.hash = boardHref({ module, id });
  };
  return (
    <Modal open onClose={onClose} title="New board">
      <form onSubmit={submit}>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" autoFocus />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-full chip px-4 h-10 font-semibold">Cancel</button>
          <button type="submit" disabled={!name.trim()} className="btn-primary rounded-full px-4 h-10 font-semibold disabled:opacity-50">Create</button>
        </div>
      </form>
    </Modal>
  );
}
