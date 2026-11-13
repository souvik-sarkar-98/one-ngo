import { Injectable, computed } from '@angular/core';
import { adminHome } from '../core/admin/areas';
import { AdminBase } from './admin-store';

/** Administration's home: the areas the person's capabilities allow. */
@Injectable()
export class AdminHomeStore extends AdminBase {
  readonly home = computed(() => {
    this.i18n.locale();
    return adminHome(this.session.me()?.capabilities);
  });
  readonly canSettings = computed(() => !!this.session.me()?.capabilities.settings);
}
