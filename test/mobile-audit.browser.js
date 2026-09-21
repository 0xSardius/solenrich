// Mobile layout audit for www.solenrich.com. Run in a browser console (or the Chrome automation tool) on a
// SAME-ORIGIN page of the site under test, for example https://www.solenrich.com/robots.txt or
// http://localhost:4173/robots.txt (local: `bunx serve -l 4173 landing`).
//
// It loads each page in an iframe at each width (media queries respond to the iframe width) and reports:
//   over     elements whose box passes the viewport edge and are not inside a scroll/clip container
//   wider    elements whose content is wider than their box (scrollWidth > clientWidth)
//   taps     links/buttons/inputs under 40px on either side (links inside running text are excluded)
//   fonts    text styles under 12px
//   inputs   form inputs under 16px (iOS Safari zooms the page on focus)
// Target: over 0, inputs 0, taps 0, and `wider` only on elements with overflow-x auto (code blocks, tables).
//
// Usage: paste this file, then:  await mobileAudit()   or   await mobileAudit(['/stonkfun'], [320, 375])

window.mobileAudit = async function (pages, widths) {
  pages = pages || ['/', '/docs', '/stonkfun', '/agent-card'];
  widths = widths || [320, 375, 430, 768];
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  };
  const results = {};
  const lines = [];
  document.body.innerHTML = '';
  document.body.style.margin = '0';

  for (const path of pages) {
    for (const width of widths) {
      const frame = document.createElement('iframe');
      // scrolling=no removes the desktop scrollbar, so the layout width equals the named width.
      frame.setAttribute('scrolling', 'no');
      frame.style.cssText = 'width:' + width + 'px;height:800px;border:0;display:block';
      frame.src = path;
      document.body.appendChild(frame);
      await new Promise((resolve, reject) => {
        frame.onload = resolve;
        setTimeout(() => reject(new Error('timeout ' + path)), 15000);
      });
      await new Promise((r) => setTimeout(r, 1200));

      const d = frame.contentDocument;
      const w = frame.contentWindow;
      const vw = d.documentElement.clientWidth;
      const clipParent = (el) => {
        for (let p = el.parentElement; p && p !== d.body; p = p.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(w.getComputedStyle(p).overflowX)) return true;
        }
        return false;
      };

      const over = [];
      for (const el of d.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if ((r.right > vw + 1 || r.left < -1) && !clipParent(el)) over.push(name(el) + ' [' + Math.round(r.left) + ' to ' + Math.round(r.right) + ']');
      }

      const wider = [...d.querySelectorAll('*')]
        .filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2)
        .map((e) => name(e) + ' ' + e.clientWidth + '/' + e.scrollWidth + ' ' + w.getComputedStyle(e).overflowX);

      const taps = [];
      for (const el of d.body.querySelectorAll('a, button, input, select, textarea, summary, [role=button], [onclick]')) {
        const r = el.getBoundingClientRect();
        const cs = w.getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden') continue;
        if (cs.display === 'inline' && el.closest('p, li, td, dd, footer')) continue;
        if (r.height < 40 || r.width < 40) taps.push(name(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }

      const fonts = {};
      const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim()) continue;
        const p = n.parentElement;
        const cs = w.getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || !p.getBoundingClientRect().width) continue;
        const size = parseFloat(cs.fontSize);
        if (size < 12) fonts[size + 'px ' + name(p)] = (fonts[size + 'px ' + name(p)] || 0) + n.nodeValue.trim().length;
      }

      const inputs = [...d.querySelectorAll('input, textarea, select')]
        .filter((e) => parseFloat(w.getComputedStyle(e).fontSize) < 16)
        .map((e) => name(e) + ' ' + w.getComputedStyle(e).fontSize);

      results[path + ' at ' + width] = { over, wider, taps, fonts, inputs, height: d.documentElement.scrollHeight };
      lines.push(path + ' at ' + width + ': over ' + over.length + ', wider ' + wider.length + ', taps ' + taps.length +
        ', fonts ' + Object.keys(fonts).length + ', inputs ' + inputs.length + ', height ' + d.documentElement.scrollHeight);
      frame.remove();
    }
  }
  window.mobileAuditResults = results;
  return lines.join('\n');
};
