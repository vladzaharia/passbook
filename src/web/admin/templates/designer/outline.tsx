import { lazy, type ReactNode, Suspense } from 'react';
import { readAccess } from './access/model.ts';
import { useDesigner } from './context.tsx';
import { readCounters } from './counters.ts';
import { SectionSkeleton } from './designer-skeleton.tsx';
import { Disclosure } from './disclosure.tsx';
import { readInputs } from './inputs.ts';
import {
  type DraftAsset,
  fieldsOf,
  type GroupId,
  groupsFor,
  legacyStyleOf,
  listCount,
  styleOf,
} from './model.ts';
import { readActions } from './scan/actions/model.ts';
import { StyleSection } from './section-style.tsx';
import { TemplateSection } from './section-template.tsx';
import { STRIP_STYLES } from './stamps.ts';

/**
 * Template and Style stay in the first load (Style is the section the designer opens on). Every
 * other section loads when it opens, behind a skeleton of its panel: the stamps editor, the scan
 * actions, access, inputs and the rest never reach a visit that does not open them.
 */
const AccessSection = lazy(() =>
  import('./access/access-section.tsx').then((m) => ({ default: m.AccessSection })),
);
const ActionsSection = lazy(() =>
  import('./scan/actions/actions-section.tsx').then((m) => ({ default: m.ActionsSection })),
);
const BarcodeSection = lazy(() =>
  import('./section-barcode.tsx').then((m) => ({ default: m.BarcodeSection })),
);
const ColorsSection = lazy(() =>
  import('./section-colors.tsx').then((m) => ({ default: m.ColorsSection })),
);
const CountersSection = lazy(() =>
  import('./section-counters.tsx').then((m) => ({ default: m.CountersSection })),
);
const FieldsSection = lazy(() =>
  import('./section-fields.tsx').then((m) => ({ default: m.FieldsSection })),
);
const ImagesSection = lazy(() =>
  import('./section-images.tsx').then((m) => ({ default: m.ImagesSection })),
);
const InputsSection = lazy(() =>
  import('./section-inputs.tsx').then((m) => ({ default: m.InputsSection })),
);
const RelevanceSection = lazy(() =>
  import('./section-relevance.tsx').then((m) => ({ default: m.RelevanceSection })),
);
const StampsSection = lazy(() =>
  import('./section-stamps.tsx').then((m) => ({ default: m.StampsSection })),
);

function Panel({ children }: { children: ReactNode }) {
  return <Suspense fallback={<SectionSkeleton />}>{children}</Suspense>;
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
          <Panel>
            <ColorsSection />
          </Panel>
        </Disclosure>
        <Disclosure section="images" index={next()} count={filledSlots(doc.assets)}>
          <Panel>
            <ImagesSection />
          </Panel>
        </Disclosure>
        {STRIP_STYLES.some((s) => s === style) ? (
          <Disclosure section="stamps" index={next()}>
            <Panel>
              <StampsSection />
            </Panel>
          </Disclosure>
        ) : null}
        <Disclosure section="counters" index={next()} count={readCounters(doc).length}>
          <Panel>
            <CountersSection />
          </Panel>
        </Disclosure>
        {groups.map((g: GroupId) => (
          <Disclosure
            key={g}
            section={g}
            index={next()}
            count={fieldsOf(doc.passJson, g, doc.target).length}
          >
            <Panel>
              <FieldsSection group={g} />
            </Panel>
          </Disclosure>
        ))}
        <Disclosure section="inputs" index={next()} count={readInputs(doc.manifest).length}>
          <Panel>
            <InputsSection />
          </Panel>
        </Disclosure>
        <Disclosure section="barcode" index={next()}>
          <Panel>
            <BarcodeSection />
          </Panel>
        </Disclosure>
        <Disclosure section="access" index={next()} count={readAccess(doc)?.plans.length}>
          <Panel>
            <AccessSection />
          </Panel>
        </Disclosure>
        <Disclosure section="scan-actions" index={next()} count={readActions(doc).length}>
          <Panel>
            <ActionsSection />
          </Panel>
        </Disclosure>
        <Disclosure section="relevance" index={next()} count={listCount(doc)}>
          <Panel>
            <RelevanceSection />
          </Panel>
        </Disclosure>
      </ul>
    </nav>
  );
}
