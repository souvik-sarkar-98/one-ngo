/** Sends an in-app message to people or roles; the notification use case implements it. */
export interface RecordNotifier {
  notifyText(
    tenantId: string,
    input: { to: { users?: string[]; roles?: string[] }; subject: string; body: string; recordId?: string; link?: string; exclude?: string[] },
  ): Promise<number>;
}
