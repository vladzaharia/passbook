import { MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, FormField, FormSpan, Input } from '../../../ui/index.ts';
import {
  type LocationPair,
  locationError,
  locationLabel,
  mapsUrl,
  parseLocation,
} from './location.ts';
import type { FormValues } from './schema.ts';

const asText = (lat: unknown, lng: unknown) =>
  typeof lat === 'number' && typeof lng === 'number' ? `${lat}, ${lng}` : '';

/**
 * One field for a latitude and longitude pair: type "47.61, -122.33" or paste an Apple or Google
 * Maps link, and both coordinates fill. Open in Maps checks the spot.
 */
export function LocationInput({
  pair,
  value,
  onChange,
  disabled,
  serverError,
}: {
  pair: LocationPair;
  value: FormValues;
  onChange: (patch: Record<string, unknown>) => void;
  disabled?: boolean | undefined;
  serverError?: string | undefined;
}) {
  const stored = asText(value[pair.lat.key], value[pair.lng.key]);
  const [text, setText] = useState(stored);
  // A new stored value (reset, discard, server) replaces the text unless it already says the same.
  useEffect(() => {
    setText((t) => {
      const p = parseLocation(t);
      return p && asText(p.lat, p.lng) === stored ? t : stored;
    });
  }, [stored]);
  const parsed = parseLocation(text);
  const error = serverError ?? locationError(parsed, text);
  const label = locationLabel(pair);
  return (
    <FormSpan full>
      <div className="flex flex-col gap-4">
        <FormField
          label={label}
          required={pair.lat.required}
          help="Latitude, longitude or a Maps link."
          error={error}
        >
          {(c) => (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input
                {...c}
                inputMode="decimal"
                placeholder="Lat, long or Maps link"
                disabled={disabled}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  const next = parseLocation(e.target.value);
                  if (!e.target.value.trim())
                    onChange({ [pair.lat.key]: undefined, [pair.lng.key]: undefined });
                  else if (next && !locationError(next, e.target.value))
                    onChange({ [pair.lat.key]: next.lat, [pair.lng.key]: next.lng });
                }}
              />
              <Button
                asChild
                variant="outline"
                iconStart={<MapPin aria-hidden />}
                disabled={!parsed || Boolean(error)}
              >
                <a
                  href={parsed && !error ? mapsUrl(parsed) : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-disabled={!parsed || Boolean(error) || undefined}
                >
                  Open in Maps
                </a>
              </Button>
            </div>
          )}
        </FormField>
        {pair.text ? (
          <FormField label={pair.text.label} help="Shown on the lock screen near this place.">
            {(c) => (
              <Input
                {...c}
                disabled={disabled}
                value={
                  typeof value[pair.text?.key ?? ''] === 'string'
                    ? String(value[pair.text?.key ?? ''])
                    : ''
                }
                onChange={(e) => onChange({ [pair.text?.key ?? '']: e.target.value || undefined })}
              />
            )}
          </FormField>
        ) : null}
      </div>
    </FormSpan>
  );
}
