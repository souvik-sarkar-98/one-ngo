import { randomUUID } from 'node:crypto';

/** An RFC 822 message for an http email sender to deliver (for example Gmail's raw message). HTML is a second part; without it the message stays plain text. */
export function rfc822(message: { from: string; to: string; subject: string; text: string; html?: string }): string {
  const headers = [
    `From: ${address(message.from)}`,
    `To: ${address(message.to)}`,
    `Subject: ${encodeHeader(oneLine(message.subject))}`,
    'MIME-Version: 1.0',
  ];
  const text = message.text.replace(/\r?\n/g, '\r\n');
  if (!message.html) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit');
    return `${headers.join('\r\n')}\r\n\r\n${text}`;
  }
  const boundary = `ngo-${randomUUID()}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, body: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`;
  const html = message.html.replace(/\r?\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', text)}${part('text/html', html)}--${boundary}--\r\n`;
}

/** Header values cannot carry line breaks; they would start new headers. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/** `Name <addr>` keeps the address plain and encodes only a non-ASCII display name. */
function address(value: string): string {
  const v = oneLine(value).trim();
  const m = /^(.*?)\s*<([^<>]*)>$/.exec(v);
  if (!m) return v;
  const name = m[1]!.replace(/^"(.*)"$/, '$1');
  if (!name) return `<${m[2]}>`;
  return `${isAscii(name) ? m[1] : encodeHeader(name)} <${m[2]}>`;
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** RFC 2047 base64 encoded-words, each at most 75 characters and never splitting a character. */
function encodeHeader(value: string): string {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
