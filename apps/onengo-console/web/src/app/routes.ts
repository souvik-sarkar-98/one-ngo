import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import type { OperatorActionContract } from '@onengo/platform/contracts';
import { ActivityScreen } from './activity/activity.screen';
import { FindScreen, OnboardScreen, StatusScreen } from './organisations/screens';
import { SignInScreen } from './organisations/sign-in.screen';
import { OperatorScreen, OperatorsScreen } from './operators/operators.screen';
import { CallbackPage, SignInPage, StepUpPage } from './sign-in/sign-in.page';
import { OperatorApi } from './services/operator-api';

/** The route needs this operator action. A signed-out visitor goes to sign-in; a signed-in operator without the action is refused. */
const operatorGuard = (action: OperatorActionContract): CanActivateFn => async (_route, state) => {
  const api = inject(OperatorApi);
  const router = inject(Router);
  try {
    const session = api.session() ?? await api.loadSession();
    if (!session.authenticated) return router.createUrlTree(['/sign-in'], { queryParams: { next: state.url } });
    return api.can(action);
  } catch {
    return router.createUrlTree(['/sign-in'], { queryParams: { next: state.url } });
  }
};

export const routes: Routes = [
  { path: 'sign-in', component: SignInPage },
  { path: 'auth/callback', component: CallbackPage },
  { path: 'step-up', component: StepUpPage },
  { path: 'organisations', component: FindScreen, canActivate: [operatorGuard('status')] },
  { path: 'organisations/find', component: FindScreen, canActivate: [operatorGuard('status')] },
  { path: 'organisations/status', component: StatusScreen, canActivate: [operatorGuard('status')] },
  { path: 'organisations/onboard', component: OnboardScreen, canActivate: [operatorGuard('onboard')] },
  { path: 'organisations/sign-in', component: SignInScreen, canActivate: [operatorGuard('sign_in')] },
  { path: 'operators', component: OperatorsScreen, canActivate: [operatorGuard('operators')] },
  { path: 'operators/:id', component: OperatorScreen, canActivate: [operatorGuard('operators')] },
  { path: 'activity', component: ActivityScreen, canActivate: [operatorGuard('audit')] },
  { path: '', pathMatch: 'full', redirectTo: 'organisations' },
  { path: '**', redirectTo: 'organisations' },
];
