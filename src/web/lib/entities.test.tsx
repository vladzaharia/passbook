import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ART_NAMES } from '../ui/art/index.ts';
import { EmptyState } from '../ui/empty-state.tsx';
import { PALETTE_GROUPS } from '../ui/layout/palette.tsx';
import { ACTIONS, actionOf } from './actions.ts';
import {
  CONNECTOR_ICON,
  connectorIcon,
  ENTITY,
  ENTITY_KINDS,
  type EntityKind,
} from './entities.ts';
import { ADMIN_NAV } from './nav.ts';

const WEB = join(process.cwd(), 'src/web');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !name.includes('.test.') ? [path] : [];
  });

/** Audit action prefixes whose create event shows the entity glyph on timelines. */
const CREATE: Partial<Record<EntityKind, string>> = {
  pass: 'pass.create',
  template: 'template.upload',
  connection: 'connection.create',
  org: 'org.create',
  identity: 'identity.upload',
  apiKey: 'api_key.create',
};
const GROUP: Partial<Record<EntityKind, keyof typeof PALETTE_GROUPS>> = {
  pass: 'passes',
  template: 'templates',
  connection: 'connections',
  user: 'users',
  org: 'orgs',
};

describe('entity registry', () => {
  it.each(ENTITY_KINDS)('%s resolves everywhere to its registry glyph and art', (kind) => {
    const entity = ENTITY[kind];
    for (const item of ADMIN_NAV.filter((i) => i.entity === kind)) {
      expect(item.icon).toBe(entity.icon);
    }
    const group = GROUP[kind];
    if (group) expect(PALETTE_GROUPS[group].icon).toBe(entity.icon);
    const create = CREATE[kind];
    if (create) expect(actionOf(create).icon).toBe(entity.icon);
    const { container } = render(<EmptyState art={entity.art} title="Empty" />);
    // The buddy holds the entity's own art.
    expect(container.querySelector(`[data-buddy] [data-art="${entity.art}"]`)).not.toBeNull();
  });

  it('gives each entity its own art and glyph', () => {
    const arts = ENTITY_KINDS.map((k) => ENTITY[k].art);
    expect(new Set(arts).size).toBe(arts.length);
    for (const art of arts) expect(ART_NAMES).toContain(art);
    const icons = ENTITY_KINDS.map((k) => ENTITY[k].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('maps every audit action to a glyph and a tone', () => {
    for (const [code, entry] of Object.entries(ACTIONS)) {
      expect(entry.icon, code).toBeTruthy();
      expect(entry.tone, code).toMatch(/^(success|info|warning|danger|neutral|accent)$/);
    }
    expect(actionOf('auth.sign_in').icon).not.toBe(actionOf('api_key.create').icon);
    expect(actionOf('user.email_primary').label).toBe('Primary email changed');
  });
});

describe('web sources', () => {
  const files = sources(WEB).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('use no retired icon or size', () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/Fingerprint|size-4\.5/);
    }
  });

  it('give every menu item an icon', () => {
    let items = 0;
    for (const { path, text } of files) {
      for (const m of text.matchAll(/<DropdownMenuItem\b([\s\S]*?)<\/DropdownMenuItem>/g)) {
        items++;
        expect(m[1], path).toMatch(/aria-hidden/);
      }
    }
    expect(items).toBeGreaterThan(5);
  });
});

describe('connector icons', () => {
  it('gives every registered connector its own glyph', () => {
    const dir = join(process.cwd(), 'src/worker/connectors');
    const types = readdirSync(dir)
      .filter((name) => statSync(join(dir, name)).isDirectory())
      .flatMap((name) => {
        const file = join(dir, name, 'index.ts');
        try {
          // The definition's own type sits at the object's top level (two-space indent).
          return [/^ {2}type: '([a-z0-9-]+)',$/m.exec(readFileSync(file, 'utf8'))?.[1]];
        } catch {
          return [];
        }
      })
      .filter((t): t is string => Boolean(t));
    expect(types).toContain('webhook-push');
    for (const type of types) expect(CONNECTOR_ICON[type], type).toBeDefined();
    const glyphs = new Set(types.map(connectorIcon));
    expect(glyphs.size).toBe(types.length);
    expect(glyphs.has(ENTITY.connection.icon)).toBe(false);
  });
});
