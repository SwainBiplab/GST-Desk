// One orchestrated moment: the hero invoice writes itself once, when it scrolls into view.
// Without JS, or with reduced motion, the finished invoice is simply shown.
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const invoice = document.getElementById('invoice');
const totalEl = document.getElementById('total');

function play() {
  const lines = [...invoice.querySelectorAll('.line')];
  const stamp = invoice.querySelector('.stamp');
  const to = Number(totalEl.dataset.to);
  const fmt = (n) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  totalEl.textContent = fmt(0);
  lines.forEach((el, i) => setTimeout(() => el.classList.add('on'), 350 + i * 450));
  const countStart = 350 + lines.length * 450;
  setTimeout(() => {
    const t0 = performance.now();
    const dur = 900;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      totalEl.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
      else setTimeout(() => stamp.classList.add('on'), 150);
    };
    requestAnimationFrame(step);
  }, countStart);
}

if (invoice && totalEl && !reduce) {
  document.documentElement.classList.add('js');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          play();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(invoice);
  } else {
    play();
  }
}
