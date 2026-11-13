import type { EmailMessage, EmailTransport } from '../ports/index.js';
export type { EmailMessage, EmailTransport } from '../ports/index.js';

export class MemoryTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}
export class SmtpTransport implements EmailTransport {
  private transporter: { sendMail(message: Record<string, unknown>): Promise<unknown> } | null = null;
  constructor(private readonly options: SmtpOptions) {}
  async send(message: EmailMessage): Promise<void> {
    this.transporter ??= (await import('nodemailer')).default.createTransport({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      auth: { user: this.options.user, pass: this.options.password },
    });
    const mail: Record<string, unknown> = { from: this.options.from, to: message.to, subject: message.subject, text: message.text };
    if (message.html) mail.html = message.html;
    await this.transporter.sendMail(mail);
  }
}
