import { useSession } from '../../lib/session.ts';
import { useNewPassWizard } from './new-pass-wizard.ts';
import { NewPassWizardView } from './new-pass-wizard-view.tsx';

export function NewPassPage({
  templateId,
}: {
  orgId?: string | undefined;
  templateId?: string | undefined;
}) {
  const session = useSession();
  const principalId = !session.isError ? session.authed?.user.id : undefined;
  return (
    <NewPassWizard
      key={JSON.stringify([principalId ?? null, templateId ?? null])}
      linkTemplate={templateId}
      principalId={principalId}
      sessionReady={principalId !== undefined && !session.isFetching}
    />
  );
}

function NewPassWizard(props: {
  linkTemplate: string | undefined;
  principalId: string | undefined;
  sessionReady: boolean;
}) {
  const model = useNewPassWizard(props);
  return <NewPassWizardView model={model} />;
}
