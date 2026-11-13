import { describe, expect, it } from 'vitest';
import { PHONE_QUERY, isHighlighted, resolveGuide } from './model';
import { GUIDE } from './catalogue';

describe('highlight', () => {
  it('outlines only the control the step names', () => {
    expect(isHighlighted('chip:Outstanding', 'chip:Outstanding')).toBe(true);
    expect(isHighlighted('chip:Outstanding', 'chip:Mine')).toBe(false);
  });

  it('draws nothing when a step names no control', () => {
    expect(isHighlighted(undefined, 'row')).toBe(false);
    expect(isHighlighted('', 'row')).toBe(false);
  });

  it('switches to the phone arrangement below 760px', () => {
    expect(PHONE_QUERY).toBe('(max-width: 759.98px)');
  });
});

describe('user guide catalogue', () => {
  it('covers the design wireframes and the connector runtime', () => {
    expect(GUIDE.map((section) => section.id)).toEqual(['app', 'builder', 'sign-in', 'organisation', 'connectors']);
    expect(GUIDE.find((section) => section.id === 'app')?.source).toContain('ngo-app-navigation-flows.html');
    expect(GUIDE.find((section) => section.id === 'connectors')?.source).toContain('connector-runtime.html');
  });

  it('gives every chapter at least one step for both arrangements', () => {
    const ids = GUIDE.flatMap((section) => section.chapters.map((chapter) => `${section.id}/${chapter.id}`));
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of GUIDE) {
      expect(section.chapters.length).toBeGreaterThan(0);
      for (const chapter of section.chapters) {
        expect(chapter.steps.length).toBeGreaterThan(0);
        for (const step of chapter.steps) {
          expect(step.mobile.length).toBeGreaterThan(0);
          expect(step.web.length).toBeGreaterThan(0);
          expect(step.path.startsWith('/')).toBe(true);
        }
      }
    }
  });

  it('sends an unknown chapter back to a real one in that section', () => {
    expect(resolveGuide(GUIDE, 'app', 'missing')).toEqual({ sectionId: 'app', chapterId: 'sign-in' });
    expect(resolveGuide(GUIDE, 'connectors', 'lookup').chapterId).toBe('lookup');
    expect(resolveGuide(GUIDE, 'nope', 'nope').sectionId).toBe('app');
  });
});
