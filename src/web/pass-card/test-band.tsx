import { TEST_BAND_COPY } from '../../shared/copy/developer.ts';
import './test-band.css';

/**
 * The band a sandbox pass carries on every channel (PassCard, Google, Samsung, paper). Real text,
 * so a screen reader and a printout say it too. Callers show it only for a pass in a developer org.
 */
export function TestBand() {
  return (
    <div className="test-band" role="note">
      {TEST_BAND_COPY}
    </div>
  );
}
