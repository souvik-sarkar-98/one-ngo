import { describe, expect, it } from 'vitest';
import { asLocation, fromLocationDraft, fromPosition, isLowAccuracy, locationProblems, locationText, mapsUrl, toLocationDraft } from './location';

describe('location values', () => {
  it('rounds a device position to six decimals and whole metres', () => {
    expect(fromPosition({ latitude: 18.50211449, longitude: 73.9258714, accuracy: 12.4 }, 'Home')).toEqual({ lat: '18.502114', lng: '73.925871', accuracy: '12', label: 'Home' });
  });

  it('sends nothing when empty, numbers when typed well, and the text as typed otherwise', () => {
    expect(fromLocationDraft({ lat: '', lng: '', accuracy: '', label: ' ' })).toBeNull();
    expect(fromLocationDraft({ lat: '18.5021149', lng: ' 73.925871 ', accuracy: '', label: 'Home' })).toEqual({ lat: 18.502115, lng: 73.925871, label: 'Home' });
    expect(fromLocationDraft({ lat: '18.5', lng: '73.9', accuracy: '350', label: '' })).toEqual({ lat: 18.5, lng: 73.9, accuracy: 350 });
    expect(fromLocationDraft({ lat: 'north', lng: '73.9', accuracy: '', label: '' })).toEqual({ lat: 'north', lng: '73.9' });
  });

  it('checks typed coordinates against the ranges the server enforces', () => {
    expect(locationProblems({ lat: '98.5', lng: '73.9', accuracy: '', label: '' })).toEqual({ lat: 'Latitude: −90 to 90.' });
    expect(locationProblems({ lat: '18.5', lng: '-181', accuracy: '', label: '' })).toEqual({ lng: 'Longitude: −180 to 180.' });
    expect(locationProblems({ lat: '18.5', lng: '', accuracy: '', label: '' })).toEqual({ lng: 'Longitude is required.' });
    expect(locationProblems({ lat: '', lng: '', accuracy: '', label: '' })).toEqual({});
  });

  it('shows the label or the coordinates, flags low accuracy, and links out to a map', () => {
    const stored = { lat: 18.502114, lng: 73.925871, accuracy: 12, label: 'Home, Hadapsar' };
    expect(toLocationDraft(stored)).toEqual({ lat: '18.502114', lng: '73.925871', accuracy: '12', label: 'Home, Hadapsar' });
    expect(toLocationDraft(null)).toEqual({ lat: '', lng: '', accuracy: '', label: '' });
    expect(locationText(stored)).toBe('Home, Hadapsar');
    expect(locationText({ lat: 18.5, lng: 73.9 })).toBe('18.500000, 73.900000');
    expect(locationText(null)).toBe('—');
    expect(asLocation({ lat: '', lng: 1 })).toBeNull();
    expect(isLowAccuracy(350)).toBe(true);
    expect(isLowAccuracy(12)).toBe(false);
    expect(mapsUrl(stored)).toBe('https://www.openstreetmap.org/?mlat=18.502114&mlon=73.925871#map=17/18.502114/73.925871');
  });
});
