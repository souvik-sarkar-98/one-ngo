/* Shared behaviour for every OneNGO doc page. No libraries, no network.
 *
 * Works on any page that uses docs.css: <header class="appbar">, <nav class="rail">, and
 * <section class="card"> blocks inside <main>. Everything here is optional polish: with
 * scripts off the pages still read top to bottom.
 *
 *   - "who is this for" chips from data-for="users admins operators"
 *   - heading anchors, and a mini contents bar for sections with four or more h3
 *   - Hide/Show on each section, with #fold-all and #unfold-all buttons when present
 *   - reading progress bar, back-to-top button, highlighted rail link
 *   - copy buttons on <pre class="cmd">
 *   - opens a folded section or <details> when a link or the address points inside it
 */
(function () {
  'use strict';
  var $ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var slug = function (s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48); };
  var cards = $('main section.card');

  // Who a section is written for.
  var names = { users: 'Users', admins: 'Admins', operators: 'Operators' };
  cards.forEach(function (card) {
    if (card.classList.contains('builder-ref')) return;
    var who = (card.getAttribute('data-for') || '').split(/\s+/).filter(Boolean);
    var h2 = card.querySelector('h2');
    if (!h2 || !who.length || !who.every(function (w) { return names[w]; })) return;
    var chip = document.createElement('span');
    chip.className = 'scope';
    chip.textContent = who.length === 3 ? 'Everyone' : who.map(function (w) { return names[w]; }).join(' + ');
    h2.appendChild(chip);
  });

  // A copy-link anchor on every h3, and a mini contents bar for long sections.
  var used = {};
  cards.forEach(function (card) {
    var h3s = $('h3', card).filter(function (h) { return !h.closest('details'); });
    h3s.forEach(function (h) {
      var base = (card.id || 's') + '-' + (slug(h.textContent) || 'h');
      var id = h.id || base, n = 2;
      while (!h.id && (used[id] || document.getElementById(id))) id = base + '-' + (n++);
      used[id] = 1;
      h.id = id;
      var a = document.createElement('a');
      a.className = 'anchor'; a.href = '#' + id; a.textContent = '#'; a.setAttribute('aria-label', 'Link to this heading');
      h.appendChild(a);
    });
    if (h3s.length >= 4 && !card.querySelector(':scope > .mini-toc')) {
      var nav = document.createElement('nav');
      nav.className = 'mini-toc';
      nav.setAttribute('aria-label', 'In this section');
      var lead = document.createElement('span');
      lead.textContent = 'In this section';
      nav.appendChild(lead);
      h3s.forEach(function (h) {
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent.replace(/#$/, '').replace(/^Step (\d+)\s*/, 'Step $1: ');
        nav.appendChild(a);
      });
      var h2 = card.querySelector('h2');
      if (h2) h2.parentNode.insertBefore(nav, h2.nextSibling);
    }
  });

  // Hide and show sections.
  function setFold(card, folded) {
    card.classList.toggle('is-folded', folded);
    var b = card.querySelector(':scope > h2 > .fold');
    if (b) { b.setAttribute('aria-expanded', folded ? 'false' : 'true'); b.textContent = folded ? 'Show' : 'Hide'; }
  }
  cards.forEach(function (card) {
    var h2 = card.querySelector(':scope > h2');
    if (!h2) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'fold'; b.textContent = 'Hide'; b.setAttribute('aria-expanded', 'true');
    b.addEventListener('click', function () { setFold(card, !card.classList.contains('is-folded')); });
    h2.appendChild(b);
  });
  var foldAll = document.getElementById('fold-all');
  var unfoldAll = document.getElementById('unfold-all');
  if (foldAll) foldAll.addEventListener('click', function () { cards.forEach(function (c) { setFold(c, true); }); });
  if (unfoldAll) unfoldAll.addEventListener('click', function () { cards.forEach(function (c) { setFold(c, false); }); });

  // Open whatever a link points into: a folded section or a closed <details>.
  function reveal(hash) {
    if (!hash || hash.length < 2) return;
    var target;
    try { target = document.getElementById(decodeURIComponent(hash.slice(1))); } catch (e) { return; }
    if (!target) return;
    var card = target.closest('section.card');
    if (card && card.classList.contains('is-folded')) setFold(card, false);
    for (var d = target.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    if (target.tagName === 'DETAILS') target.open = true;
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a) reveal(a.getAttribute('href'));
  });
  window.addEventListener('hashchange', function () { reveal(location.hash); });
  reveal(location.hash);

  // Copy buttons.
  $('pre.cmd').forEach(function (pre) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'copy'; b.textContent = 'Copy'; b.setAttribute('aria-label', 'Copy this command');
    b.addEventListener('click', function () {
      var text = pre.innerText.replace(/\n?Copy$/, '').replace(/\s+$/, '');
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
      else {
        var t = document.createElement('textarea');
        t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
        document.body.removeChild(t);
      }
    });
    pre.appendChild(b);
  });

  // On phones the contents rail is hidden behind a hamburger button in the app bar.
  (function () {
    var railEl = document.querySelector('.rail');
    var appbar = document.querySelector('.appbar');
    if (!railEl || !appbar) return;
    if (!railEl.id) railEl.id = 'doc-rail';
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'menu-btn'; btn.innerHTML = '&#9776;';
    btn.setAttribute('aria-label', 'Contents'); btn.setAttribute('aria-controls', railEl.id); btn.setAttribute('aria-expanded', 'false');
    appbar.insertBefore(btn, appbar.firstChild);
    var back = document.createElement('button');
    back.type = 'button'; back.className = 'rail-backdrop'; back.setAttribute('aria-label', 'Close contents'); back.tabIndex = -1;
    document.body.appendChild(back);
    function setOpen(open) {
      document.body.classList.toggle('rail-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.innerHTML = open ? '&#10005;' : '&#9776;';
    }
    btn.addEventListener('click', function () { setOpen(!document.body.classList.contains('rail-open')); });
    back.addEventListener('click', function () { setOpen(false); });
    railEl.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 760) setOpen(false); });
  })();

  // Reading progress, back to top, and the highlighted rail link.
  var bar = document.getElementById('progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'progress'; bar.className = 'progress'; bar.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(bar, document.body.firstChild);
  }
  var rail = document.querySelector('.rail');
  var railLinks = $('.rail a[href^="#"]').map(function (a) { return { a: a, el: document.getElementById(a.getAttribute('href').slice(1)) }; }).filter(function (x) { return x.el; });
  var top = document.createElement('button');
  top.type = 'button'; top.className = 'totop'; top.setAttribute('aria-label', 'Back to top'); top.innerHTML = '&#8593;';
  top.addEventListener('click', function () { window.scrollTo({ top: 0 }); });
  document.body.appendChild(top);
  var ticking = false, current = null;
  function update() {
    ticking = false;
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    bar.style.width = (max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0) + '%';
    top.classList.toggle('show', window.scrollY > 600);
    var line = 56 + 40, best = null;
    railLinks.forEach(function (x) {
      if (!x.el.offsetParent) return;
      if (x.el.getBoundingClientRect().top <= line) best = x;
    });
    if (best && best !== current) {
      if (current) current.a.classList.remove('active');
      best.a.classList.add('active');
      current = best;
      if (rail && rail.scrollHeight > rail.clientHeight) {
        var r = best.a.getBoundingClientRect(), rr = rail.getBoundingClientRect();
        if (r.top < rr.top + 8 || r.bottom > rr.bottom - 8) rail.scrollTop += r.top - rr.top - rr.height / 3;
      }
    }
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update);
  $('.switcher button').forEach(function (b) { b.addEventListener('click', function () { setTimeout(update, 0); }); });
  update();

  // Hides a link whose target is missing: a same-site file that does not load, or a #fragment
  // that names nothing on the page it points to. An HTML target counts only as a doc page (it
  // has the shared app bar), so a site's app shell at the same address does not pass. Browsers
  // do not let a page read files from disk, so this runs only when the pages are served.
  if (location.protocol !== 'file:' && window.fetch && window.DOMParser) {
    var checked = {};
    var fetchTarget = function (path) {
      if (!checked[path]) {
        checked[path] = fetch(path, { credentials: 'same-origin' }).then(function (res) {
          if (!res.ok) return null;
          if (!/\.html$/i.test(path)) return { doc: null };
          return res.text().then(function (html) {
            if (html.indexOf('class="appbar"') < 0) return null;
            return { doc: new DOMParser().parseFromString(html, 'text/html') };
          });
        }).catch(function () { return null; });
      }
      return checked[path];
    };
    var hide = function (a) { a.style.display = 'none'; };
    var fragment = function (u) { try { return decodeURIComponent(u.hash.slice(1)); } catch (e) { return ''; } };
    $('a[href]').forEach(function (a) {
      var u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
      if (u.origin !== location.origin) return;
      var id = fragment(u);
      if (u.pathname === location.pathname) {
        if (id && !document.getElementById(id)) hide(a);
        return;
      }
      fetchTarget(u.pathname).then(function (target) {
        if (!target) return hide(a);
        if (id && target.doc && !target.doc.getElementById(id)) hide(a);
      });
    });
  }
})();
