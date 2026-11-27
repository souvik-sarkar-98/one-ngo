import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { ChapterScreen } from '../../../../apps/onengo-guide/web/src/app/guide/chapter.screen';
import { GuideHome } from '../../../../apps/onengo-guide/web/src/app/guide/home.screen';
import { routes } from '../../../../apps/onengo-guide/web/src/app/routes';

describe('user guide routes', () => {
  it('opens the guide home at the root', () => {
    expect(routes[0]?.path).toBe('');
    expect(routes[0]?.component).toBe(GuideHome);
  });

  it('opens every topic at its section and chapter', () => {
    const topic = routes.find((route) => route.path === ':section/:chapter');
    expect(topic?.component).toBe(ChapterScreen);
    expect(topic?.canActivate?.length).toBe(1);
  });

  it('sends an unknown address back to the home', () => {
    expect(routes.find((route) => route.path === '**')?.redirectTo).toBe('');
  });
});
