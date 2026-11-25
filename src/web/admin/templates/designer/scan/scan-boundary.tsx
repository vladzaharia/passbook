import { Component, type ReactNode } from 'react';
import { Button, Callout } from '../../../../ui/index.ts';

/** A failure in the scan screen stays inside it: the reason, and a way back to the pass. */
export class ScanBoundary extends Component<
  { onBack: () => void; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Callout
        tone="danger"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              this.setState({ error: null });
              this.props.onBack();
            }}
          >
            Back to Pass
          </Button>
        }
      >
        Scan screen failed to load: {error.message}
      </Callout>
    );
  }
}
