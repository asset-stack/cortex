import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useRoute } from '@/lib/router';
import { MODULES, useAccess } from '@/lib/access';
import Sidebar, { MobileNav } from '@/components/layout/Sidebar';
import ChatDock from '@/components/chat/ChatDock';
import BoardPage from '@/components/board/BoardPage';
import TimesheetPrompt from '@/components/timesheet/TimesheetPrompt';
import MyWork from '@/pages/MyWork';
import Pipeline from '@/pages/Pipeline';
import Clients from '@/pages/Clients';
import Outreach from '@/pages/Outreach';
import Settings from '@/pages/Settings';

function Page({ route, sub }) {
  switch (route) {
    case 'projects':
    case 'marketing':
      return <BoardPage module={route} sub={sub} />;
    case 'pipeline': return <Pipeline />;
    case 'clients': return sub ? <BoardPage module="clients" sub={sub} /> : <Clients />;
    // #/outreach and #/clients are their own pages; #/outreach/<board id> and #/clients/<board id> their boards.
    case 'outreach': return sub ? <BoardPage module="outreach" sub={sub} /> : <Outreach />;
    case 'settings': return <Settings />;
    default: return <MyWork />;
  }
}

// Settings is admins only; a module the user can't see (access 'none') falls back to My Work.
function allowed(route, access) {
  if (route === 'settings') return access.isAdmin;
  return !MODULES.includes(route) || access.canView(route);
}

export default function App() {
  const access = useAccess();
  const at = useRoute();
  const ok = allowed(at.route, access);
  const route = ok ? at.route : 'work';
  const sub = ok ? at.sub : ''; // the board id under Projects / Marketing / Outreach / Clients
  const scroller = useRef(null);
  const dock = useRef(null);
  const [dockH, setDockH] = useState(0);
  const [, tick] = useReducer((n) => n + 1, 0);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [route, sub]);

  // Relative times ("5m") and the My Work greeting are worked out at render time: re-render every
  // minute and when the tab comes back so they don't go stale.
  useEffect(() => {
    const id = setInterval(tick, 60_000);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // Pad the page by the dock's height (collapsed bar or open chat) so the last rows can scroll above it.
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setDockH(el.offsetHeight));
    ro.observe(el);
    setDockH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      <div className="backdrop-photo" aria-hidden="true" />
      <div className="backdrop-vignette" aria-hidden="true" />
      <div className="backdrop-grain" aria-hidden="true" />
      <div className="relative z-[2] flex h-full">
        <Sidebar route={route} sub={sub} />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <main ref={scroller} className="flex-1 overflow-y-auto scroll-thin">
            <MobileNav route={route} sub={sub} />
            <div className="mx-auto max-w-[1240px] px-4 pb-32 pt-6 md:px-8 md:pt-9" style={dockH ? { paddingBottom: `max(8rem, ${dockH + 16}px)` } : undefined}>
              {access.role === 'staff' && <TimesheetPrompt />}
              <Page route={route} sub={sub} />
            </div>
          </main>
          <div ref={dock} className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4 md:px-8">
            <div className="pointer-events-auto mx-auto max-w-[1240px] no-print"><ChatDock /></div>
          </div>
        </div>
      </div>
    </>
  );
}
