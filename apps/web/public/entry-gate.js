// Runs before the app loads (a separate file so a strict CSP can allow it).
// A first-time visitor on the web is sent to the landing page. Everyone else goes straight to the app:
// the desktop app, an installed web app, anyone who has opened the app before, and anyone who
// followed "Open the web app" (which adds ?app to the address).
try {
  // the phone app on a WebView too old to run it (Chrome 100 is the floor): say so instead of a blank screen
  var m = /Chrome\/(\d+)/.exec(navigator.userAgent);
  if (window.Capacitor && m && Number(m[1]) < 100) {
    document.addEventListener('DOMContentLoaded', function () {
      var r = document.getElementById('root');
      if (r)
        r.innerHTML =
          '<div style="font-family:sans-serif;padding:24px;line-height:1.5"><h1 style="font-size:20px">Update Android System WebView</h1><p>GST Desk needs a newer Android System WebView (Chrome ' +
          m[1] +
          ' found, 100 or later needed). Update it from the Play Store, then open the app again.</p></div>';
    });
  }
  var p = window.location;
  if (p.pathname === '/') {
    var enter = /(^|[?&])app(=|&|$)/.test(p.search);
    var ls = window.localStorage;
    if (enter) ls.setItem('gst.entered', '1');
    var inDesktop = !!(window.__TAURI_INTERNALS__ || window.__TAURI__ || window.Capacitor);
    var installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    var used = ls.getItem('gst.entered') || ls.getItem('gst.device') || ls.getItem('gst.shell');
    if (!enter && !inDesktop && !installed && !used) p.replace('/landing/');
  }
} catch (e) {}
