const os = require('os');

// A QR code is scanned by a PHONE, not by the browser on the server machine.
// That means "http://localhost:3000" is useless inside a QR — the phone would
// try to reach itself. So we always build the QR link from a real, reachable
// address instead.
//
// Priority order:
//   1. PUBLIC_BASE_URL from .env  (set this when the app is hosted on a real
//      domain or a fixed office server, e.g. https://tracker.suleco.lk)
//   2. Whatever host the browser used, IF it isn't localhost
//   3. The server machine's own LAN IP, auto-detected
//      (e.g. http://192.168.1.42:3000 — works for any phone on the same WiFi)

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((net) => {
      // Node <18 reports family as the number 4; newer versions use 'IPv4'.
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal) {
        candidates.push({ name, address: net.address });
      }
    });
  });

  if (candidates.length === 0) return null;

  // Prefer a normal private-network address over Docker/VPN adapters.
  const preferred = candidates.find((c) =>
    /^192\.168\./.test(c.address) || /^10\./.test(c.address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(c.address)
  );

  return (preferred || candidates[0]).address;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) {
    return stripTrailingSlash(process.env.PUBLIC_BASE_URL.trim());
  }

  const port = process.env.PORT || 3000;

  if (req && req.headers && req.headers.host) {
    const host = req.headers.host;
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    if (!isLocal) {
      const protocol = req.protocol || 'http';
      return stripTrailingSlash(`${protocol}://${host}`);
    }
  }

  const lanIp = detectLanIp();
  if (lanIp) return `http://${lanIp}:${port}`;

  // Absolute last resort — the QR will only work on this machine.
  return `http://localhost:${port}`;
}

module.exports = { getBaseUrl, detectLanIp };