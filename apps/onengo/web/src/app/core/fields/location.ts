import { formatNumber, t } from '../i18n/i18n';

/** A stored location: degrees to at most six decimals, accuracy in metres. */
export interface LocationValue {
  lat: number;
  lng: number;
  accuracy?: number;
  label?: string;
}

/** A location as a form holds it: text, so typed coordinates can be half-written. */
export interface LocationDraft {
  lat: string;
  lng: string;
  accuracy: string;
  label: string;
}

/** Above this many metres the accuracy is shown as low. */
export const LOW_ACCURACY_M = 100;

export const EMPTY_LOCATION: LocationDraft = { lat: '', lng: '', accuracy: '', label: '' };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function asLocation(v: unknown): LocationValue | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const lat = Number(o['lat']);
  const lng = Number(o['lng']);
  if (o['lat'] === '' || o['lng'] === '' || o['lat'] == null || o['lng'] == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const accuracy = o['accuracy'] === '' || o['accuracy'] == null ? NaN : Number(o['accuracy']);
  const label = typeof o['label'] === 'string' ? o['label'].trim() : '';
  return { lat, lng, ...(Number.isFinite(accuracy) ? { accuracy: Math.round(accuracy) } : {}), ...(label ? { label } : {}) };
}

export function toLocationDraft(v: unknown): LocationDraft {
  const l = asLocation(v);
  if (!l) return { ...EMPTY_LOCATION };
  return { lat: String(l.lat), lng: String(l.lng), accuracy: l.accuracy === undefined ? '' : String(l.accuracy), label: l.label ?? '' };
}

/** A position from the device, rounded to what the server keeps. */
export function fromPosition(coords: { latitude: number; longitude: number; accuracy: number }, label = ''): LocationDraft {
  return { lat: String(round6(coords.latitude)), lng: String(round6(coords.longitude)), accuracy: String(Math.round(coords.accuracy)), label };
}

/**
 * What a location draft sends: null when nothing is filled in, the stored
 * shape when the coordinates read as numbers, otherwise the text as typed so
 * the server reports the problem.
 */
export function fromLocationDraft(d: LocationDraft): LocationValue | Record<string, string> | null {
  const lat = d.lat.trim();
  const lng = d.lng.trim();
  const label = d.label.trim();
  if (!lat && !lng && !label) return null;
  const v = asLocation({ lat, lng, accuracy: d.accuracy.trim(), label });
  if (!v) return { lat, lng, ...(label ? { label } : {}) };
  return { ...v, lat: round6(v.lat), lng: round6(v.lng) };
}

/** The problem with typed coordinates, field by field; the server checks again on save. */
export function locationProblems(d: LocationDraft): { lat?: string; lng?: string } {
  const out: { lat?: string; lng?: string } = {};
  const name = (key: 'lat' | 'lng') => t(key === 'lat' ? 'ui.fields.location.latitude' : 'ui.fields.location.longitude');
  const check = (text: string, max: number, key: 'lat' | 'lng') => {
    const s = text.trim();
    if (!s) return;
    const n = Number(s);
    if (!Number.isFinite(n) || Math.abs(n) > max) out[key] = t('ui.fields.location.range', { field: name(key), min: `−${max}`, max: String(max) });
  };
  check(d.lat, 90, 'lat');
  check(d.lng, 180, 'lng');
  if (!out.lat && !out.lng && !!d.lat.trim() !== !!d.lng.trim()) {
    const missing = d.lat.trim() ? 'lng' : 'lat';
    out[missing] = t('ui.records.required', { field: name(missing) });
  }
  return out;
}

/** 18.502114, 73.925871. */
export const coordinates = (l: Pick<LocationValue, 'lat' | 'lng'>) => `${l.lat.toFixed(6)}, ${l.lng.toFixed(6)}`;

/** ± 12 m. */
export const accuracyText = (metres: number) => t('ui.fields.location.accuracy', { m: formatNumber(Math.round(metres)) });

export const isLowAccuracy = (metres: number | undefined) => metres !== undefined && metres > LOW_ACCURACY_M;

/** How a list shows a location: its label, or the coordinates. */
export function locationText(v: unknown): string {
  const l = asLocation(v);
  return l ? (l.label ?? coordinates(l)) : '—';
}

/**
 * The "Open in maps" destination. It is a link the person may follow, never
 * loaded by the app: no tiles or map scripts are fetched.
 */
export function mapsUrl(l: Pick<LocationValue, 'lat' | 'lng'>): string {
  const lat = l.lat.toFixed(6);
  const lng = l.lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}
