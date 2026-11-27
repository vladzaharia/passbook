import { lazy, Suspense } from 'react';
import { HomeView } from '../home/home-view.tsx';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { NoSandboxState } from '../states/states.tsx';
import '../../pass-card/barcode-loader.ts';
import '../home/home.css';

// Its own chunk: only a context with no sandbox reads the Console beside the state.
const ReadOnlyConsole = lazy(() => import('../home/readonly-console.tsx'));

/** Home: the live surface (T1). With no sandbox yet, Create sandbox once. */
export function HomePage() {
  const host = useOptionalToolHost();
  if (!host)
    return (
      <ToolPage tool="home">
        <div className="wb-tool-home flex flex-col gap-4">
          <NoSandboxState />
          <Suspense fallback={null}>
            <ReadOnlyConsole />
          </Suspense>
        </div>
      </ToolPage>
    );
  return (
    <div className="wb-tool-home contents">
      <HomeView />
    </div>
  );
}
