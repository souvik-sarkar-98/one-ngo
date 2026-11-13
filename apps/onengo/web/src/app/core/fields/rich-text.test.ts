import { describe, expect, it } from 'vitest';
import * as server from '../server';
import { RICH_TEXT_ATTRIBUTES, RICH_TEXT_ELEMENTS, RICH_TEXT_LINK_SCHEMES, cleanRichText, safeLinkHref, sanitiseRichText } from './rich-text';

/** Markup that must never reach the screen, and what is left of it. */
const ATTACKS: [string, string][] = [
  ['<p>Hello <script>alert(1)</script>world</p>', '<p>Hello world</p>'],
  ['<SCRIPT SRC=//evil.example/x.js></SCRIPT>after', 'after'],
  ['<script>a</script><script>b</script>ok', 'ok'],
  ['<p onclick="alert(1)" class="x">Hi</p>', '<p>Hi</p>'],
  ['<strong onmouseover=alert(1)>b</strong>', '<strong>b</strong>'],
  ["<em onfocus='x()' autofocus tabindex=0>e</em>", '<em>e</em>'],
  ['<img src=x onerror=alert(1)>pic', 'pic'],
  ['<body onload=alert(1)>text</body>', 'text'],
  ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
  ['<a href="JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
  ['<a href=" javascript:alert(1)">x</a>', '<a>x</a>'],
  ['<a href="java&#x09;script:alert(1)">x</a>', '<a>x</a>'],
  ['<a href="java&#10;script:alert(1)">x</a>', '<a>x</a>'],
  ['<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>', '<a>x</a>'],
  ['<a href="vbscript:msgbox(1)">x</a>', '<a>x</a>'],
  ['<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>', '<a>x</a>'],
  ['<a href="data:image/svg+xml,<svg onload=alert(1)>">x</a>', '<a>x</a>'],
  ['<a href="/relative">x</a>', '<a>x</a>'],
  ['<a href="https://example.org" target="_blank" style="color:red">ok</a>', '<a href="https://example.org" rel="noopener noreferrer">ok</a>'],
  ['<a href="https://example.org" rel="opener">ok</a>', '<a href="https://example.org" rel="noopener noreferrer">ok</a>'],
  ['<a href="mailto:help@example.org">mail</a>', '<a href="mailto:help@example.org" rel="noopener noreferrer">mail</a>'],
  ['<a href="https://example.org/?q=&quot;><script>alert(1)</script>">x</a>', '<a href="https://example.org/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" rel="noopener noreferrer">x</a>'],
  ['<p style="background:url(javascript:alert(1))">s</p>', '<p>s</p>'],
  ['<style>@import url(//evil.example/x.css)</style>after', 'after'],
  ['<p>a</p><link rel=stylesheet href=//evil.example/x.css>', '<p>a</p>'],
  ['<iframe src="https://evil.example"><p>inside</p></iframe>after', 'after'],
  ['<object data="x.swf"><embed src="x.swf"></object>after', 'after'],
  ['<svg><script>alert(1)</script></svg>ok', 'ok'],
  ['<math><mtext><script>alert(1)</script></mtext></math>ok', 'ok'],
  ['<form action="https://evil.example"><input name=x><button>Go</button></form>', 'Go'],
  ['<template><script>alert(1)</script></template>ok', 'ok'],
  ['<noscript><p title="</noscript><img src=x onerror=alert(1)>">', ''],
  ['<!-- <script>x</script> -->text', 'text'],
  ['<!--><script>alert(1)</script>-->ok', 'ok'],
  ['<<script>script>alert(1)<</script>/script>', '&lt;/script&gt;'],
  ['<scr<script>ipt>alert(1)</script>', 'ipt&gt;alert(1)'],
  ['<p>unclosed <strong>bold', '<p>unclosed <strong>bold</strong></p>'],
  ['<ul><li>one<li>two</ul>', '<ul><li>one<li>two</li></li></ul>'],
  ['</p></strong>stray closes', 'stray closes'],
  ['<p>a<br/>b</p>', '<p>a<br>b</p>'],
  ['<b>bold</b> <i>it</i> <u>u</u>', '<strong>bold</strong> <em>it</em> <u>u</u>'],
  ['<h1>Big</h1><h3>Small</h3><blockquote>q</blockquote>', 'Big<h3>Small</h3><blockquote>q</blockquote>'],
  ['1 < 2 & 3 > 2', '1 &lt; 2 &amp; 3 &gt; 2'],
  ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['<p x="a>b">t</p>', '<p>t</p>'],
];

describe('rich text on the device', () => {
  it('uses the server allow-list: the same elements, attributes and link schemes', () => {
    expect([...RICH_TEXT_ELEMENTS]).toEqual([...server.RICH_TEXT_ELEMENTS]);
    expect([...RICH_TEXT_ELEMENTS].sort()).toEqual(['a', 'blockquote', 'br', 'em', 'h3', 'h4', 'li', 'ol', 'p', 'strong', 'u', 'ul']);
    expect(RICH_TEXT_ATTRIBUTES).toEqual(server.RICH_TEXT_ATTRIBUTES);
    expect(RICH_TEXT_ATTRIBUTES).toEqual({ a: ['href', 'rel'] });
    expect([...RICH_TEXT_LINK_SCHEMES]).toEqual([...server.RICH_TEXT_LINK_SCHEMES]);
    expect([...RICH_TEXT_LINK_SCHEMES].sort()).toEqual(['http:', 'https:', 'mailto:']);
  });

  it.each(ATTACKS)('cleans %s', (input, output) => {
    expect(sanitiseRichText(input)).toBe(output);
    expect(sanitiseRichText(input)).toBe(server.sanitiseRichText(input));
  });

  it('leaves no script, handler, style or unsafe link in anything it keeps', () => {
    for (const [input] of ATTACKS) {
      const out = cleanRichText(input);
      expect(out, input).not.toMatch(/<(script|style|iframe|object|embed|svg|math|img|form|input|link|template|noscript)\b/i);
      expect(out, input).not.toMatch(/\son\w+\s*=/i);
      expect(out, input).not.toMatch(/\sstyle\s*=/i);
      expect(out, input).not.toMatch(/href="(?!https?:|mailto:)/i);
      for (const tag of out.matchAll(/<([a-z0-9]+)([^>]*)>/gi)) {
        expect(RICH_TEXT_ELEMENTS as readonly string[], input).toContain(tag[1]!.toLowerCase());
        const attrs = [...tag[2]!.matchAll(/\s([a-z-]+)=/gi)].map((m) => m[1]!);
        expect(attrs.every((a) => (RICH_TEXT_ATTRIBUTES[tag[1]!] ?? []).includes(a)), input).toBe(true);
      }
    }
  });

  it('keeps lines and headings from browsers and word processors when pasting', () => {
    expect(cleanRichText('<div>First line</div><div>Second <b>bold</b></div>')).toBe('<p>First line</p><p>Second <strong>bold</strong></p>');
    expect(cleanRichText('<h1 class="Title">Visit</h1><h2>Notes</h2><h6>small</h6>')).toBe('<h3>Visit</h3><h3>Notes</h3><h4>small</h4>');
    expect(cleanRichText('<div onclick="x()" style="color:red">a</div>')).toBe('<p>a</p>');
    expect(cleanRichText('<html><head><style>p{}</style><title>T</title></head><body><p class="MsoNormal"><span style="font-size:12pt">Word <o:p></o:p>text</span></p></body></html>')).toBe(
      '<p>Word text</p>',
    );
    expect(cleanRichText('<div x="><script>alert(1)</script>">t</div>')).not.toMatch(/script/);
  });

  it('treats markup with no words as empty', () => {
    expect(cleanRichText('<p><br></p>')).toBe('');
    expect(cleanRichText('<script>alert(1)</script>')).toBe('');
    expect(cleanRichText('')).toBe('');
  });

  it('accepts only web and email links in the link box', () => {
    expect(safeLinkHref('https://example.org/a')).toBe('https://example.org/a');
    expect(safeLinkHref('example.org')).toBe('https://example.org');
    expect(safeLinkHref('help@example.org')).toBe('mailto:help@example.org');
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,x')).toBeNull();
    expect(safeLinkHref('  ')).toBeNull();
  });
});
