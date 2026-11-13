import type { Tx } from '../../../domain/ports/transaction.js';

export interface NewNotification {
  userId: string | null;
  channel: string;
  to: string | null;
  subject: string;
  body: string;
  /** HTML alternative for an email. Other channels leave it unset. */
  html?: string;
  recordId?: string;
  link?: string;
  /** 'sent' also stamps the sending time. */
  status: string;
}

export interface OutgoingNotification {
  to_address: string;
  subject: string;
  body: string;
  html: string | null;
  record_id: string | null;
  status: string;
}

export interface InboxRow {
  id: string;
  subject: string;
  body: string;
  record_id: string | null;
  link: string | null;
  read_at: Date | string | null;
  created_at: Date | string;
}

/** Notifications and their recipients in the organisation of the open transaction. */
export interface NotificationStore {
  /** Active members holding any of the roles. */
  roleMembers(tx: Tx, roles: string[]): Promise<string[]>;
  /** The people among `userIds` who are active members, with their email and language (else the organisation's). */
  activeMembers(tx: Tx, userIds: string[]): Promise<{ id: string; email: string | null; locale: string }[]>;
  /** Each role the people hold, with its permissions. */
  roleGrants(tx: Tx, userIds: string[]): Promise<{ user_id: string; role_key: string; permissions: string[] }[]>;
  defaultLocale(tx: Tx): Promise<string | null>;
  add(tx: Tx, n: NewNotification): Promise<string>;
  outgoing(tx: Tx, id: string): Promise<OutgoingNotification | undefined>;
  /** Sets the delivery status and error; 'sent' stamps the sending time. */
  mark(tx: Tx, id: string, status: string, error: string | null): Promise<void>;
  /** The person's in-app notifications, newest first, after the `before` one when given. */
  inbox(tx: Tx, userId: string, options: { unreadOnly: boolean; before?: string; limit: number }): Promise<InboxRow[]>;
  markAllRead(tx: Tx, userId: string): Promise<number>;
  /** False when the person has no such in-app notification. */
  markRead(tx: Tx, userId: string, id: string): Promise<boolean>;
}
