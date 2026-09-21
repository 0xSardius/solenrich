// Shared script for every page on www.solenrich.com: the mobile menu.
// The inline head script sets <html class="js">; site.css collapses the nav links only when that class is present.
(function () {
  var nav = document.querySelector('.site-nav');
  if (!nav) return;
  var toggle = nav.querySelector('.nav-toggle');
  var links = nav.querySelector('.nav-links');
  if (!toggle || !links) return;

  function setOpen(open) {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toggle.addEventListener('click', function () {
    setOpen(!nav.classList.contains('open'));
  });

  links.addEventListener('click', function (e) {
    if (e.target.closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('open')) {
      setOpen(false);
      toggle.focus();
    }
  });

  document.addEventListener('click', function (e) {
    if (nav.classList.contains('open') && !nav.contains(e.target)) setOpen(false);
  });

  // The panel is a mobile layout; close it when the viewport grows past the breakpoint.
  window.matchMedia('(min-width: 1025px)').addEventListener('change', function (e) {
    if (e.matches) setOpen(false);
  });
})();
