import { gateTests } from '../shared/gate';

gateTests({
  'Content-Security-Policy': /^sandbox allow-scripts; default-src 'none'; .*frame-ancestors http:\/\/localhost:8787; webrtc 'block'$/,
  'X-Robots-Tag': /^noindex, nofollow$/,
  'X-Content-Type-Options': /^nosniff$/,
  'Referrer-Policy': /^no-referrer$/,
  'Permissions-Policy': /^camera=\(\), microphone=\(\), geolocation=\(\), usb=\(\), payment=\(\)$/,
  'X-DNS-Prefetch-Control': /^off$/,
}, '*');
