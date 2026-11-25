import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useChangeCount } from '../../../lib/motion.ts';
import { Badge } from '../../../ui/index.ts';
import { AccessSection } from './access/access-section.tsx';
import { readAccess } from './access/model.ts';
import { useDesigner } from './context.tsx';
import { readCounters } from './counters.ts';
import { readInputs } from './inputs.ts';
import {
  type DraftAsset,
  fieldsOf,
  type GroupId,
  groupsFor,
  legacyStyleOf,
  listCount,
  type Section,
  sectionLabel,
  styleOf,
} from './model.ts';
import { ActionsSection } from './scan/actions/actions-section.tsx';
import { readActions } from './scan/actions/model.ts';
import { BarcodeSection } from './section-barcode.tsx';
import { ColorsSection } from './section-colors.tsx';
import { CountersSection } from './section-counters.tsx';
import { FieldsSection } from './section-fields.tsx';
import { ImagesSection } from './section-images.tsx';
import { InputsSection } from './section-inputs.tsx';
import { RelevanceSection } from './section-relevance.tsx';
import { StampsSection } from './section-stamps.tsx';
import { StyleSection } from './section-style.tsx';
import { TemplateSection } from './section-template.tsx';
import { STRIP_STYLES } from './stamps.ts';

/** The count pops when it changes, not when the page opens. */
function Count({ n }: { n: number }) {
  const changes = useChangeCount(n);
  return (
    <Badge key={changes} className={changes > 0 ? 'dz-count' : undefined}>
      {n}
    </Badge>
  );
}

function Disclosure({
  section,
  count,
  index,
  children,
}: {
  section: Section;
  count?: number | undefined;
  index: number;
  children: ReactNode;
}) {
  const { state, select } = useDesigner();
  const open = state.select.section === section;
  const id = useId();
  return (
    <li
      className="dz-section"
      data-open={open || undefined}
      style={{ '--i': index } as React.CSSProperties}
    >
      <h2>
        <button
          type="button"
          className="dz-head"
          data-target={section}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => select(open ? { section: 'none' } : { section })}
        >
          <ChevronRight aria-hidden className="dz-chevron size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{sectionLabel(section)}</span>
          {count !== undefined ? <Count n={count} /> : null}
        </button>
      </h2>
      {open ? (
        <section id={id} aria-label={sectionLabel(section)} className="dz-panel">
          {children}
        </section>
      ) : null}
    </li>
  );
}

/** Image slots with a file of their own, whatever the scales. */
const filledSlots = (assets: readonly DraftAsset[]): number =>
  new Set(assets.filter((a) => a.slot && !a.name.includes('/')).map((a) => a.slot)).size;

/** The structure of the template: one section per concern; the open one is its inspector. */
export function Outline() {
  const { doc } = useDesigner();
  const style = legacyStyleOf(doc.passJson);
  const groups = groupsFor(styleOf(doc.passJson, doc.target));
  let n = 0;
  const next = () => n++;
  return (
    <nav aria-label="Structure">
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <Disclosure section="template" index={next()}>
          <TemplateSection />
        </Disclosure>
        <Disclosure section="style" index={next()}>
          <StyleSection />
        </Disclosure>
        <Disclosure section="colors" index={next()}>
          <ColorsSection />
        </Disclosure>
        <Disclosure section="images" index={next()} count={filledSlots(doc.assets)}>
          <ImagesSection />
        </Disclosure>
        {STRIP_STYLES.some((s) => s === style) ? (
          <Disclosure section="stamps" index={next()}>
            <StampsSection />
          </Disclosure>
        ) : null}
        <Disclosure section="counters" index={next()} count={readCounters(doc).length}>
          <CountersSection />
        </Disclosure>
        {groups.map((g: GroupId) => (
          <Disclosure
            key={g}
            section={g}
            index={next()}
            count={fieldsOf(doc.passJson, g, doc.target).length}
          >
            <FieldsSection group={g} />
          </Disclosure>
        ))}
        <Disclosure section="inputs" index={next()} count={readInputs(doc.manifest).length}>
          <InputsSection />
        </Disclosure>
        <Disclosure section="barcode" index={next()}>
          <BarcodeSection />
        </Disclosure>
        <Disclosure section="access" index={next()} count={readAccess(doc)?.plans.length}>
          <AccessSection />
        </Disclosure>
        <Disclosure section="scan-actions" index={next()} count={readActions(doc).length}>
          <ActionsSection />
        </Disclosure>
        <Disclosure section="relevance" index={next()} count={listCount(doc)}>
          <RelevanceSection />
        </Disclosure>
      </ul>
    </nav>
  );
}
