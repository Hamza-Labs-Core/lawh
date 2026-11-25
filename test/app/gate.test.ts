import { gateTests } from '../shared/gate';

gateTests({
  'Content-Security-Policy': /^default-src 'none'; script-src 'self'; .*frame-src http:\/\/127\.0\.0\.1:8787; .*base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/,
  'X-Robots-Tag': /^noindex, nofollow$/,
  'X-Content-Type-Options': /^nosniff$/,
  'Referrer-Policy': /^no-referrer$/,
  'Cross-Origin-Opener-Policy': /^same-origin$/,
  'Permissions-Policy': /camera=\(\).*publickey-credentials-get=\(self\)/,
});
