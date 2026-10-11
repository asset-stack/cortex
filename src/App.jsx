import { useEffect, useRef } from 'react';
import { useRoute } from '@/lib/router';
import Sidebar, { MobileNav } from '@/components/layout/Sidebar';
import ChatDock from '@/components/chat/ChatDock';
import Board from '@/components/board/Board';
import MyWork from '@/pages/MyWork';
import Pipeline from '@/pages/Pipeline';
import Clients from '@/pages/Clients';
import Outreach from '@/pages/Outreach';

function Page({ route }) {
  switch (route) {
    case 'projects':
    case 'admin':
    case 'marketing':
      return <Board key={route} boardKey={route} />;
    case 'pipeline': return <Pipeline />;
    case 'clients': return <Clients />;
    case 'outreach': return <Outreach />;
    default: return <MyWork />;
  }
}

export default function App() {
  const route = useRoute();
  const scroller = useRef(null);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [route]);

  return (
    <>
      <div className="backdrop-photo" aria-hidden="true" />
      <div className="backdrop-vignette" aria-hidden="true" />
      <div className="backdrop-grain" aria-hidden="true" />
      <div className="relative z-[2] flex h-full">
        <Sidebar route={route} />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <main ref={scroller} className="flex-1 overflow-y-auto scroll-thin">
            <MobileNav route={route} />
            <div className="mx-auto max-w-[1240px] px-4 pb-32 pt-6 md:px-8 md:pt-9">
              <Page route={route} />
            </div>
          </main>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4 md:px-8">
            <div className="pointer-events-auto mx-auto max-w-[1240px] no-print"><ChatDock /></div>
          </div>
        </div>
      </div>
    </>
  );
}
