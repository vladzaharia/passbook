import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import type { PassJson, TemplateManifest } from '../../types.ts';
import { bakedSlugs, loadBaked } from '../baked-fixtures.ts';
import { defaultScanDisplay } from './defaults.ts';
import { renderScanDisplay } from './render.ts';
import { sampleScope } from './sample.ts';
import { NOW } from './test-kit.ts';
import { scanDisplayIssues } from './validate.ts';

describe.each(bakedSlugs())('%s default display', (slug) => {
  it('is a valid doc with no errors', async () => {
    const { template } = await loadBaked(slug);
    const display = defaultScanDisplay(template.manifest, template.passJson as PassJson);
    const manifest: TemplateManifest = {
      ...template.manifest,
      scan: {
        actions: template.manifest.scan?.actions ?? [
          { id: 'check_in', label: 'Check in', kind: 'check_in' },
        ],
        display,
      },
    };
    const issues = scanDisplayIssues(manifest, { passJson: template.passJson as PassJson });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('matches its snapshot, and so does each screen it renders', async () => {
    const { template } = await loadBaked(slug);
    const display = defaultScanDisplay(template.manifest, template.passJson as PassJson);
    expect(display).toMatchSnapshot('doc');
    const scope = sampleScope(template.manifest, { now: NOW, fields: sampleFields(display) });
    for (const screen of ['ready', 'ok', 'heads_up', 'refused'] as const) {
      const out = renderScanDisplay(display, scope, {
        screen,
        role: 'desk',
        locale: 'en',
        timeZone: 'UTC',
        now: NOW,
      });
      expect(() => ScanDisplaySchema.parse(out)).not.toThrow();
      expect(out).toMatchSnapshot(screen);
    }
  });
});

/** Every `fields.<key>` the default reads, with a stand-in value. */
function sampleFields(display: ReturnType<typeof defaultScanDisplay>): Record<string, string> {
  const keys = JSON.stringify(display).matchAll(/fields\.([\w-]+)/g);
  return Object.fromEntries([...keys].map((m) => [m[1] as string, `Sample ${m[1]}`]));
}
