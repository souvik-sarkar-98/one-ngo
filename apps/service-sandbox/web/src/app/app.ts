import { Component } from '@angular/core';
import { InboxScreen } from './inbox.screen';

@Component({
  selector: 'inbox-root',
  imports: [InboxScreen],
  template: '<inbox-screen />',
})
export class App {}
