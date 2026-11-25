/** Security model, section 4. `frame-src` gets the content host with S3, when there is something to frame. */
export const appHeaders: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "connect-src 'self'",
    "frame-src 'none'", "manifest-src 'self'", "worker-src 'self'", "font-src 'self'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': [
    'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()', 'encrypted-media=()', 'fullscreen=()',
    'geolocation=()', 'gyroscope=()', 'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()',
    'picture-in-picture=()', 'screen-wake-lock=()', 'usb=()', 'xr-spatial-tracking=()',
    'publickey-credentials-create=(self)', 'publickey-credentials-get=(self)',
  ].join(', '),
};
