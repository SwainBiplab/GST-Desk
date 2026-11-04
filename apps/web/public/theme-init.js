// Applied before first paint (a separate file so a strict CSP can allow it): saved theme and language.
try {
  var t = localStorage.getItem('data-theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  var l = localStorage.getItem('gst.lang');
  if (l) document.documentElement.lang = l;
} catch (e) {}
