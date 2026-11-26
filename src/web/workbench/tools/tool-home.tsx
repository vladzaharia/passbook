import { WorkbenchIsland } from '../home/island.tsx';
import { LegacyTool } from './legacy.tsx';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import '../home/workbench.css';
import '../home/workbench-cards.css';

/** Home (T1 rebuilds it): the moved Workbench cards. */
export function HomePage() {
  return (
    <LegacyTool tool="home" className="wb-tool-home" closed={<WorkbenchIsland />}>
      {() => <WorkbenchIsland />}
    </LegacyTool>
  );
}
