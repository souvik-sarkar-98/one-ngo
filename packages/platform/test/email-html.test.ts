import { describe, expect, it } from 'vitest';
import { rfc822 } from '../src/application/connectors/rfc822.js';
import { renderEmailHtml, renderTemplate } from '../src/runtime/definitions/template.js';
import { sanitiseEmailHtml } from '../src/shared/records/email-html.js';

const scope = { record: { donorName: 'Asha <script>"x"', amount: 300 } };

describe('email HTML', () => {
  it('escapes placeholder values and drops scripts, handlers and javascript links', () => {
    const html = renderEmailHtml(
      '<p onclick="alert(1)">Dear {{ record.donorName }}</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><table><tr><td style="color:red">Thanks</td></tr></table>',
      scope,
    );
    expect(html).toContain('Asha &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<table>');
    expect(html).toContain('style="color:red"');
    expect(html).toContain('<a>x</a>');
  });

  it('keeps an https image and a safe link, and drops a data url and an event on the image', () => {
    const html = sanitiseEmailHtml(
      '<img src="https://cdn.example/logo.png" alt="Logo" onerror="alert(1)"><img src="data:text/html,x"><a href="https://example.org">site</a>',
    );
    expect(html).toContain('<img src="https://cdn.example/logo.png" alt="Logo">');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('data:');
    expect(html).toContain('<a href="https://example.org" rel="noopener noreferrer">site</a>');
  });

  it('drops a dangerous style declaration and keeps the safe one', () => {
    expect(sanitiseEmailHtml('<p style="color:red;background:url(javascript:alert(1))">Hi</p>')).toBe('<p style="color:red">Hi</p>');
  });

  it('leaves a plain template as plain text', () => {
    expect(renderTemplate('Hello {{ record.donorName }}', scope)).toBe('Hello Asha <script>"x"');
  });

  it('writes a plain message unchanged, and a multipart message when there is HTML', () => {
    const plain = rfc822({ from: 'info@asha.test', to: 'donor@x.test', subject: 'Thanks', text: 'Hello\nthere' });
    expect(plain).toContain('Content-Type: text/plain; charset=utf-8');
    expect(plain).not.toContain('multipart/alternative');
    expect(plain).toContain('Hello\r\nthere');

    const both = rfc822({ from: 'info@asha.test', to: 'donor@x.test', subject: 'Thanks', text: 'Hello', html: '<p>Hello</p>' });
    expect(both).toContain('multipart/alternative');
    expect(both).toContain('Content-Type: text/plain; charset=utf-8');
    expect(both).toContain('Content-Type: text/html; charset=utf-8');
    expect(both).toContain('Hello');
    expect(both).toContain('<p>Hello</p>');
  });
});
