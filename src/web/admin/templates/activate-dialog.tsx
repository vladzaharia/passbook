import { Button, Dialog, DialogContent, toast } from '../../ui/index.ts';
import { useTemplateActions } from './api.ts';
import { type Template, versionName, versionNumber } from './versions.ts';

/** Making a version active moves every live pass to it; the Versions tab and the designer ask the same way. */
export function ActivateDialog({
  template,
  version,
  onClose,
  onActivated,
}: {
  template: Template;
  /** The version hash to activate; null keeps the dialog closed. */
  version: string | null;
  onClose: () => void;
  onActivated?: () => void;
}) {
  const actions = useTemplateActions(template.id);
  const n = versionNumber(template, version);
  const name = versionName(n);
  const passes = template.passCount;
  return (
    <Dialog open={version !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title={`Activate ${name.toLowerCase()}?`}
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={actions.activate.isPending}
              onClick={async () => {
                if (!version) return;
                try {
                  await actions.activate.mutateAsync({ version });
                  toast.success(`${name} active. Passes update shortly.`);
                  onActivated?.();
                  onClose();
                } catch (cause) {
                  toast.error(cause, 'Could not activate');
                }
              }}
            >
              Activate
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted">
          {passes === 0
            ? 'No passes use this template yet.'
            : `Update ${passes} ${passes === 1 ? 'pass' : 'passes'} to ${name.toLowerCase()}.`}
        </p>
      </DialogContent>
    </Dialog>
  );
}
