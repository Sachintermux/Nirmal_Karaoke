/* Nirmal Karaoke: optional support message (UPI + email).
 *
 * Self-contained and independent of the studio code: it reads nothing from it and changes nothing in it.
 * Everything is wrapped in try/catch so a failure here can never affect the site.
 *
 * Where it runs
 *   home   (/ or /index.html)      : never opens by itself. The static strip/section buttons open the modal on click,
 *                                    and the time spent here counts towards the studio popup (see below).
 *   studio (/studio[.html])        : non-blocking corner card once the site has been in use for AUTO_AFTER_SEC (5 min
 *                                    of cumulative visible time, counted across pages in sessionStorage "nkd_vis"),
 *                                    at least AUTO_MIN_PAGE_SEC on the studio page itself, and 10 s without a
 *                                    click/key (waived after one more minute so it still shows for a busy user)
 *   anywhere else                   : only wires up the static strip/section buttons (none exist elsewhere)
 *
 * Keyboard: a keydown listener exists ONLY while the popup is open (Escape closes it; Tab is kept inside the
 * home modal). While the popup is closed nothing listens to keydown, so soundboard hotkeys are untouched.
 * Idle detection uses keyup (an observer that cannot pre-empt a hotkey) plus pointerdown.
 *
 * Phones also get a small floating "Buy me a coffee" button after PILL_AFTER_SEC of the same cumulative visible
 * time. It is a plain upi:// link, so tapping it opens the payment-app chooser directly. It can be hidden with its
 * own x (back after 7 days) and never shows for 30 days after a coffee/copy. On the studio the corner card takes
 * its place while it is still pending (and once the card has opened, the pill is not added on top of it).
 *
 * Storage: localStorage "nk_support" = { lastShown, dismissCount, coffeeAt, stripHidden, pillHiddenAt }.
 */
(function () {
  try {
    'use strict';
    if (window.__nkdInit) return;
    window.__nkdInit = true;

    var KEY = 'nk_support';
    var UPI = 'upi://pay?pa=nirmalkaraoke@ybl&pn=Nirmal%20Karaoke&cu=INR&tn=Support%20Nirmal%20Karaoke';
    var UPI_ID = 'nirmalkaraoke@ybl';
    var MAIL = 'mailto:sachindss2000@gmail.com?subject=Nirmal%20Karaoke';
    var DAY = 86400000;
    var AUTO_AFTER_SEC = 300;     // 5 minutes of cumulative visible time on the site before the studio popup
    var AUTO_MIN_PAGE_SEC = 20;   // ...and never straight after landing on the studio page
    var PILL_AFTER_SEC = 300;     // same 5 minutes before the phone button appears

    var path = location.pathname;
    var isHome = /^\/(index\.html)?$/.test(path);
    var isStudio = /^\/studio(\.html)?\/?$/.test(path);

    // ── storage (all access guarded; if it is unavailable we never show anything automatically) ──
    function storageOk() {
      try { var k = '__nkd'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; }
    }
    function read() {
      try { var o = JSON.parse(localStorage.getItem(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
    }
    function patch(fn) {
      try { var o = read(); fn(o); localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
    }
    function sessionShown() {
      try { return sessionStorage.getItem('nkd_shown') === '1'; } catch (e) { return false; }
    }
    function markSessionShown() {
      try { sessionStorage.setItem('nkd_shown', '1'); } catch (e) { /* ignore */ }
    }

    // ── popup ──
    var popEl = null, prevFocus = null, openedAuto = false, shownThisPage = false;

    function template(modal) {
      return (modal ? '<div class="nkd-backdrop" data-nkd-backdrop>' : '') +
        '<div class="nkd-card" role="dialog"' + (modal ? ' aria-modal="true"' : '') +
        ' aria-labelledby="nkd-title" aria-describedby="nkd-desc" tabindex="-1">' +
        '<button class="nkd-close" type="button" aria-label="Close" data-nkd-close>✕</button>' +
        '<h2 class="nkd-title" id="nkd-title">Enjoying your session? ☕</h2>' +
        '<p class="nkd-text" id="nkd-desc">Nirmal Karaoke is built and run by one person. If it made your day better, you can buy me a coffee. Any amount helps keep it running and improving.</p>' +
        '<figure class="nkd-fig"><img class="nkd-qr" src="donate/upi-qr.svg" width="220" height="220" alt="UPI QR code to support Nirmal Karaoke">' +
        '<figcaption>Scan with any UPI app (PhonePe, Google Pay, Paytm, BHIM)</figcaption></figure>' +
        '<a class="nkd-btn nkd-buy" href="' + UPI.replace(/&/g, '&amp;') + '" data-nkd-coffee>☕ Buy me a coffee</a>' +
        '<div class="nkd-upirow"><code class="nkd-upi">' + UPI_ID + '</code>' +
        '<button class="nkd-btn nkd-btn-ghost" type="button" data-nkd-copy>Copy UPI ID</button></div>' +
        '<span class="nkd-sr" role="status" aria-live="polite" data-nkd-status></span>' +
        '<p class="nkd-mail">Questions, feedback or other ways to support? Email me: <a href="' + MAIL + '">sachindss2000@gmail.com</a></p>' +
        '<p class="nkd-note">UPI works in India. Outside India, email me and we’ll find a way. Supporting is always optional.</p>' +
        '<button class="nkd-later" type="button" data-nkd-close>Maybe later</button>' +
        '</div>' + (modal ? '</div>' : '');
    }

    function focusables(root) {
      return Array.prototype.filter.call(
        root.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'),
        function (el) { return el.offsetParent !== null || el === document.activeElement; });
    }

    // Registered only while the popup is open.
    function onKey(e) {
      if (!popEl) return;
      if (e.key === 'Escape') { close(true); return; }
      if (e.key === 'Tab' && isHome) {
        var card = popEl.querySelector('.nkd-card');
        var items = focusables(card);
        if (!items.length) { e.preventDefault(); card.focus(); return; }
        var first = items[0], last = items[items.length - 1], cur = document.activeElement;
        if (e.shiftKey && (cur === first || cur === card || !card.contains(cur))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (cur === last || !card.contains(cur))) { e.preventDefault(); first.focus(); }
      }
    }

    function open(auto) {
      if (popEl) return;
      var modal = isHome;
      prevFocus = document.activeElement;
      openedAuto = !!auto;
      var wrap = document.createElement('div');
      wrap.className = 'nkd-pop ' + (modal ? 'nkd-pop--modal' : 'nkd-pop--card');
      wrap.innerHTML = template(modal);
      wrap.addEventListener('click', onPopClick);
      document.body.appendChild(wrap);
      popEl = wrap;
      if (auto) {
        shownThisPage = true;
        markSessionShown();
        patch(function (o) { o.lastShown = Date.now(); });
      }
      document.addEventListener('keydown', onKey);
      var card = wrap.querySelector('.nkd-card');
      if (card) card.focus({ preventScroll: true });
    }

    function close(dismissed) {
      if (!popEl) return;
      document.removeEventListener('keydown', onKey);
      popEl.removeEventListener('click', onPopClick);
      if (popEl.parentNode) popEl.parentNode.removeChild(popEl);
      popEl = null;
      if (dismissed && openedAuto) {
        patch(function (o) { o.dismissCount = (o.dismissCount | 0) + 1; o.lastShown = Date.now(); });
      }
      openedAuto = false;
      var f = prevFocus; prevFocus = null;
      try { if (f && f !== document.body && document.contains(f) && f.focus) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }

    function noteCoffee() { patch(function (o) { o.coffeeAt = Date.now(); }); }

    function onPopClick(e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-nkd-close]')) { close(true); return; }
      if (t.closest('[data-nkd-backdrop]') && !t.closest('.nkd-card')) { close(true); return; }
      if (t.closest('[data-nkd-coffee]')) { noteCoffee(); return; }   // let the upi:// link proceed
      var cp = t.closest('[data-nkd-copy]');
      if (cp) copyId(cp, popEl && popEl.querySelector('[data-nkd-status]'));
    }

    // ── copy with a safe fallback ──
    function copyId(btn, statusEl) {
      var done = function (ok) {
        if (ok) noteCoffee();
        var msg = ok ? 'UPI ID copied' : 'Could not copy. Select the UPI ID and copy it manually.';
        if (statusEl) statusEl.textContent = msg;
        var label = btn.textContent;
        btn.textContent = ok ? 'Copied ✓' : 'Select & copy';
        setTimeout(function () { btn.textContent = label; if (statusEl) statusEl.textContent = ''; }, 2200);
      };
      var fallback = function () {
        var ok = false;
        try {
          var ta = document.createElement('textarea');
          ta.value = UPI_ID;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
          btn.focus({ preventScroll: true });
        } catch (e) { ok = false; }
        done(ok);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
          navigator.clipboard.writeText(UPI_ID).then(function () { done(true); }, fallback);
        } else { fallback(); }
      } catch (e) { fallback(); }
    }

    // ── static page elements (top strip, bottom section) ──
    function wireStatic() {
      Array.prototype.forEach.call(document.querySelectorAll('[data-nkd-open]'), function (el) {
        el.addEventListener('click', function (e) {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
          e.preventDefault();
          open(false);
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-nkd-copy]'), function (btn) {
        if (btn.closest && btn.closest('.nkd-pop')) return;
        btn.hidden = false; // hidden until JS can make it work
        btn.addEventListener('click', function () { copyId(btn, document.querySelector('[data-nkd-status-static]')); });
      });
      var x = document.querySelector('[data-nkd-strip-close]');
      if (x) {
        x.hidden = false;
        x.addEventListener('click', function () {
          document.documentElement.classList.add('nkd-nostrip');
          patch(function (o) { o.stripHidden = true; });
        });
      }
    }

    // ── automatic trigger ──
    function eligible() {
      var o = read(), now = Date.now();
      if ((o.dismissCount | 0) >= 3) return false;
      if (o.coffeeAt && now - o.coffeeAt < 30 * DAY) return false;
      if (o.lastShown && now - o.lastShown < ((o.dismissCount | 0) > 0 ? 7 * DAY : DAY)) return false;
      return true;
    }
    function adInView() {
      try {
        var ads = document.querySelectorAll('ins.adsbygoogle, iframe[id^="google_ads_iframe"]');
        for (var i = 0; i < ads.length; i++) {
          var r = ads[i].getBoundingClientRect();
          if (r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return true;
        }
      } catch (e) { /* ignore */ }
      return false;
    }
    // ── phone button: floating "Buy me a coffee" that opens the payment apps directly ──
    var pillEl = null;
    function readVis() {
      try { return parseInt(sessionStorage.getItem('nkd_vis') || '0', 10) || 0; } catch (e) { return 0; }
    }
    function writeVis(n) {
      try { sessionStorage.setItem('nkd_vis', String(n)); } catch (e) { /* ignore */ }
    }
    function pillEligible() {
      var o = read(), now = Date.now();
      if (o.coffeeAt && now - o.coffeeAt < 30 * DAY) return false;
      if (o.pillHiddenAt && now - o.pillHiddenAt < 7 * DAY) return false;
      return true;
    }
    function hidePill() {
      if (pillEl && pillEl.parentNode) pillEl.parentNode.removeChild(pillEl);
      pillEl = null;
    }
    function showPill() {
      if (pillEl) return;
      var wrap = document.createElement('div');
      wrap.className = 'nkd-pill' + (isStudio ? ' nkd-pill--studio' : '');
      var a = document.createElement('a');
      a.className = 'nkd-btn';
      a.href = UPI;
      a.textContent = '☕ Buy me a coffee';
      a.addEventListener('click', function () { noteCoffee(); setTimeout(hidePill, 400); });
      var x = document.createElement('button');
      x.className = 'nkd-pill-x';
      x.type = 'button';
      x.setAttribute('aria-label', 'Hide the Buy me a coffee button');
      x.textContent = '✕';
      x.addEventListener('click', function () { patch(function (o) { o.pillHiddenAt = Date.now(); }); hidePill(); });
      wrap.appendChild(a);
      wrap.appendChild(x);
      document.body.appendChild(wrap);
      pillEl = wrap;
    }
    function isPhone() {
      return !!(window.matchMedia && window.matchMedia('(hover:none) and (pointer:coarse)').matches); // phones/tablets only
    }

    // ── one visible-time counter drives both the studio popup and the phone button ──
    // The counter lives in sessionStorage so time on the home page counts towards the studio popup, and it only
    // advances while the tab is visible. Nothing here listens to keydown.
    function startTracking() {
      if (!(isHome || isStudio)) return;
      if (navigator.webdriver) return;                 // bots / automation
      if (window.top !== window.self) return;          // embedded
      if (!storageOk()) return;

      var autoPending = !sessionShown() && eligible();
      var pillPending = isPhone() && pillEligible();
      if (!autoPending && !pillPending) return;

      var total = readVis(), page = 0, lastAct = Date.now(), timer = 0;
      var act = function () { lastAct = Date.now(); };
      if (isStudio && autoPending) {
        window.addEventListener('pointerdown', act, { passive: true });
        window.addEventListener('keyup', act, { passive: true });
      }
      function stop() {
        clearInterval(timer);
        window.removeEventListener('pointerdown', act);
        window.removeEventListener('keyup', act);
        writeVis(total);
      }
      window.addEventListener('pagehide', function () { writeVis(total); });

      timer = setInterval(function () {
        try {
          if (document.hidden) return;
          total++; page++;
          if (total % 5 === 0) writeVis(total);

          if (autoPending) {
            if (shownThisPage || sessionShown()) autoPending = false;
            else if (total >= AUTO_AFTER_SEC) {
              if (!isStudio) autoPending = false;      // home only keeps the count; the popup appears in the studio
              else if (!popEl && page >= AUTO_MIN_PAGE_SEC &&
                       (Date.now() - lastAct >= 10000 || total >= AUTO_AFTER_SEC + 60) && !adInView()) {
                if (eligible()) { open(true); hidePill(); pillPending = false; }
                autoPending = false;
              }
            }
          }
          // On the studio the card is the prompt; the pill only covers pages/cases where the card is not coming.
          if (pillPending && total >= PILL_AFTER_SEC && !(isStudio && autoPending)) {
            pillPending = false;
            if (pillEligible() && !popEl) showPill();
          }
          if (!autoPending && !pillPending) stop();
        } catch (e) { stop(); }
      }, 1000);
    }

    function init() { try { wireStatic(); startTracking(); } catch (e) { /* silent */ } }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  } catch (e) { /* silent: the support message must never affect the site */ }
})();
