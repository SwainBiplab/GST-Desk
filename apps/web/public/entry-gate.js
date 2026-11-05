// Runs before the app loads (a separate file so a strict CSP can allow it).
// A first-time visitor on the web is sent to the landing page. Everyone else goes straight to the app:
// the desktop app, an installed web app, anyone who has opened the app before, and anyone who
// followed "Open the web app" (which adds ?app to the address).
try {
  var p = window.location;
  if (p.pathname === '/') {
    var enter = /(^|[?&])app(=|&|$)/.test(p.search);
    var ls = window.localStorage;
    if (enter) ls.setItem('gst.entered', '1');
    var inDesktop = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
    var installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    var used = ls.getItem('gst.entered') || ls.getItem('gst.device') || ls.getItem('gst.shell');
    if (!enter && !inDesktop && !installed && !used) p.replace('/landing/');
  }
} catch (e) {}
