import { useMemo } from 'react';
import { FolderKanban } from 'lucide-react';
import { useStore } from '@/data/store';
import { BOARD_SCHEMAS, STATUS } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { shortDate } from '@/lib/format';

const BOARDS = ['projects', 'marketing'];

/** Open Projects / Marketing items with `personId` among their people, soonest due first. */
export default function OnBoards({ personId }) {
  const { state } = useStore();
  const access = useAccess();
  const items = useMemo(() => BOARDS.filter((key) => access.canView(key)).flatMap((key) => (state.boards[key]?.groups || [])
    .flatMap((g) => g.items.filter((i) => !i.done && (i.values.people || []).includes(personId)).map((i) => ({ ...i, board: key }))))
    .sort((a, b) => (a.values.due || '9999').localeCompare(b.values.due || '9999')), [state.boards, personId, access]);

  return (
    <section aria-label="On boards" className="glass rounded-[24px]">
      <h2 className="flex items-center gap-2 px-5 pb-3 pt-4 font-extrabold text-[16px]">
        <FolderKanban className="h-4 w-4" aria-hidden="true" />On boards<span className="text-[12px] font-semibold dimmer tnum">{items.length}</span>
      </h2>
      {items.length === 0 ? <p className="border-t rowline px-5 py-3 dimmer">Nothing open on the boards.</p> : (
        <div className="min-w-0 overflow-x-auto scroll-thin">
          <table className="w-full text-[13.5px] sm:min-w-[520px]">
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t rowline">
                  <td className="py-3 pl-5 pr-3 font-semibold"><a href={`#/${i.board}?item=${encodeURIComponent(i.id)}`} className="hover:underline">{i.name.trim() || 'Untitled task'}</a></td>
                  <td className="hidden p-3 dimmer sm:table-cell">{BOARD_SCHEMAS[i.board].title}</td>
                  <td className="w-[112px] px-2 sm:w-[130px]"><span className="pill" style={{ backgroundColor: STATUS[i.values.status] || STATUS['Not started'] }}>{i.values.status || 'Not started'}</span></td>
                  <td className="whitespace-nowrap py-3 pl-3 pr-5 text-right dim tnum">{shortDate(i.values.due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
