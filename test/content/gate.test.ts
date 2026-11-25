import { gateTests } from '../shared/gate';

gateTests({
  'Content-Security-Policy': /^default-src 'none'; frame-ancestors 'none'; sandbox$/,
  'X-Robots-Tag': /^noindex, nofollow$/,
  'X-Content-Type-Options': /^nosniff$/,
  'Referrer-Policy': /^no-referrer$/,
  'Permissions-Policy': /^camera=\(\), microphone=\(\), geolocation=\(\), usb=\(\), payment=\(\)$/,
  'X-DNS-Prefetch-Control': /^off$/,
});
