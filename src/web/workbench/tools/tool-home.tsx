import { HomeView } from '../home/home-view.tsx';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { NoSandboxState } from '../states/states.tsx';
import '../../pass-card/barcode-loader.ts';
import '../home/home.css';

/** Home: the live surface (T1). With no sandbox yet, Create sandbox once. */
export function HomePage() {
  const host = useOptionalToolHost();
  if (!host)
    return (
      <ToolPage tool="home">
        <div className="wb-tool-home">
          <NoSandboxState />
        </div>
      </ToolPage>
    );
  return (
    <div className="wb-tool-home contents">
      <HomeView />
    </div>
  );
}
