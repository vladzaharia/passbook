import { Buddy } from '../../../ui/art/buddy.tsx';
import './lists.css';

/** An empty list: the buddy at rest over one plain line. */
export function ListEmpty({ children }: { children: string }) {
  return (
    <div className="op-list-empty">
      <Buddy scene="scan" size="sm" mood="flat" pose="rest" still />
      <p>{children}</p>
    </div>
  );
}
