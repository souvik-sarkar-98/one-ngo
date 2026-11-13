import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { ChapterScreen } from './guide/chapter.screen';
import { GuideCatalogue } from './guide/catalogue-store';
import { GuideHome } from './guide/home.screen';
import { resolveGuide } from './guide/model';

/**
 * A chapter route is known when the current catalogue has it. Records topics
 * are allowed before the organisation's definition arrives, so the player can
 * show its waiting state instead of redirecting away.
 */
const knownChapter: CanActivateFn = (route) => {
  const catalogue = inject(GuideCatalogue);
  const sectionId = route.paramMap.get('section') ?? '';
  const chapterId = route.paramMap.get('chapter') ?? '';
  const sections = catalogue.sections();
  if (sectionId === 'records' && !sections.some((section) => section.id === 'records')) return true;
  const resolved = resolveGuide(sections, sectionId, chapterId);
  if (resolved.sectionId === sectionId && resolved.chapterId === chapterId) return true;
  return inject(Router).createUrlTree(['/', resolved.sectionId, resolved.chapterId], { queryParams: route.queryParams });
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: GuideHome },
  { path: ':section/:chapter', component: ChapterScreen, canActivate: [knownChapter] },
  { path: '**', redirectTo: '' },
];
