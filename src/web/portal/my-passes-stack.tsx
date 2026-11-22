import { ChevronRight } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import type { PassView } from '@/shared/pass-view/index.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { useSession } from '../lib/session.ts';
import { Badge } from '../ui/index.ts';
import { ModePill } from '../ui/layout/mode-pill.tsx';
import { FrontPass } from './front-pass.tsx';
import { PassStack, type StackPeek } from './pass-stack.tsx';
import { holderPassName, type MyPass } from './pass-view.ts';
import { isEnded, type StackGroups } from './stack-order.ts';

export interface StackItem {
  pass: MyPass;
  view: PassView;
}

export interface MyPassesStackProps {
  groups: StackGroups<StackItem>;
  front: StackItem | null;
  dealt: boolean;
  /** The front rose in place of a view transition. */
  raise: boolean;
  buddy?: ReactNode;
  nameRef?: Ref<HTMLAnchorElement>;
  onPick: (id: string) => void;
  /** Master-detail at /passes/:id: the front is the page's pass; removing it leaves the page. */
  selected?: boolean;
  onFrontRemoved?: () => void;
}

function Count({ n }: { n: number }) {
  return (
    <Badge tone="neutral" className="min-w-5.5 justify-center tabular-nums">
      {n}
    </Badge>
  );
}

/**
 * My passes' side: the front pass and the live passes' peeks, then a Test group, then Voided and
 * expired, closed while anything else is there. Every peek can come forward, whatever its group.
 */
export function MyPassesStack(props: MyPassesStackProps) {
  const { groups, front, onPick } = props;
  const { authed } = useSession();
  const peeksOf = (items: readonly StackItem[]): StackPeek[] =>
    items
      .filter((item) => item.pass.id !== front?.pass.id)
      .map(({ pass, view }) => ({
        id: pass.id,
        view,
        name: holderPassName(pass, authed?.user),
        href: `/passes/${encodeURIComponent(pass.id)}`,
        dim: isEnded(pass, view),
        removed: pass.removedAt !== null,
      }));
  const test = peeksOf(groups.test);
  const ended = peeksOf(groups.ended);
  const onlyEnded = groups.live.length === 0 && groups.test.length === 0;
  return (
    <div className="wl-mp-stack">
      <PassStack
        label={HOLDER_COPY.stackLabel}
        className="wl-buddy-room [--wl-buddy-room:3.5rem]"
        raise={props.raise}
        peeks={peeksOf(groups.live)}
        onPick={onPick}
        front={
          front ? (
            <FrontPass
              key={front.pass.id}
              pass={front.pass}
              view={front.view}
              ended={isEnded(front.pass, front.view)}
              dealt={props.dealt}
              buddy={props.buddy}
              nameRef={props.nameRef}
              selected={props.selected}
              {...(props.onFrontRemoved ? { onRemoved: props.onFrontRemoved } : {})}
            />
          ) : null
        }
      />
      {test.length > 0 ? (
        <section aria-labelledby="mp-test" className="wl-mp-group" data-group="test">
          <h2 id="mp-test" className="wl-mp-group-title">
            <ModePill mode="test" />
            <Count n={groups.test.length} />
          </h2>
          <PassStack label={HOLDER_COPY.testTitle} peeks={test} onPick={onPick} />
        </section>
      ) : null}
      {ended.length > 0 ? (
        <section className="wl-mp-group" data-group="ended">
          <details className="wl-ended-details" open={onlyEnded || undefined}>
            <summary>
              <ChevronRight aria-hidden />
              {HOLDER_COPY.endedTitle}
              <Count n={groups.ended.length} />
            </summary>
            <PassStack label={HOLDER_COPY.endedTitle} peeks={ended} onPick={onPick} />
          </details>
        </section>
      ) : null}
    </div>
  );
}
