import { CODE_COPY } from '../../../shared/copy/developers-code.ts';

/** Text, not a dot: the language's SDK is not published and the sample is plain HTTP. */
export function SdkBadge({ lang }: { lang?: string }) {
  return (
    <span className="sdk-badge" title={CODE_COPY.sdkTip} data-badge={lang}>
      {CODE_COPY.sdkPreview}
      <span className="sr">. {CODE_COPY.sdkTip}</span>
    </span>
  );
}
