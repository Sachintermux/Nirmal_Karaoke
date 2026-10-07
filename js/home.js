// Home page behaviour: mobile menu, reveal-on-scroll, and old studio bookmarks.

// The studio used to live at "/" (e.g. "/#mixer"). Send those old links to the studio page.
const STUDIO_HASHES = ['#stage', '#music', '#lyrics', '#mixer', '#effects', '#audience', '#recording', '#lobby'];
const sendLegacyHash = () => {
  if (STUDIO_HASHES.includes(location.hash)) location.replace('./studio.html' + location.hash);
};
sendLegacyHash();
window.addEventListener('hashchange', sendLegacyHash);

// Mobile menu
const burger = document.getElementById('hmBurger');
const links = document.getElementById('hmLinks');
if (burger && links) {
  const close = () => { links.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); };
  burger.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(open));
  });
  links.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// Reveal sections as they scroll into view (content stays visible if IntersectionObserver is missing)
const items = document.querySelectorAll('.hm-reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  items.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 3, 2) * 70}ms`;
    io.observe(el);
  });
} else {
  items.forEach((el) => el.classList.add('in'));
}

const year = document.getElementById('hmYear');
if (year) year.textContent = String(new Date().getFullYear());
