// A small software authenticator: one P-256 passkey, "none" attestation. Enough to test every check of the server.
const encoder = new TextEncoder();
export const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const header = (major: number, n: number): Uint8Array => (n < 24 ? Uint8Array.of((major << 5) | n) : n < 256 ? Uint8Array.of((major << 5) | 24, n) : Uint8Array.of((major << 5) | 25, n >> 8, n & 255));
const text = (s: string): Uint8Array => join(header(3, s.length), encoder.encode(s));
const bytes = (b: Uint8Array): Uint8Array => join(header(2, b.length), b);

/** The signature as ASN.1, which is how authenticators send it. */
function der(raw: Uint8Array): Uint8Array {
  const part = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const body = b[i]! & 0x80 ? join(Uint8Array.of(0), b.slice(i)) : b.slice(i);
    return join(Uint8Array.of(2, body.length), body);
  };
  const body = join(part(raw.slice(0, 32)), part(raw.slice(32)));
  return join(Uint8Array.of(0x30, body.length), body);
}

export interface Change { origin?: string; rpId?: string; flags?: number; challenge?: string; type?: string; userHandle?: string }
const ORIGIN = 'http://localhost:8787', RP = 'localhost';

export class Authenticator {
  counter = 0;
  private constructor(readonly id: Uint8Array, private keys: CryptoKeyPair) {}
  static async make(idLength = 32): Promise<Authenticator> {
    return new Authenticator(crypto.getRandomValues(new Uint8Array(idLength)), await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair);
  }
  get credentialId(): string { return b64(this.id); }

  private client(type: string, challenge: string, change: Change): Uint8Array {
    return encoder.encode(JSON.stringify({ type: change.type ?? type, challenge: change.challenge ?? challenge, origin: change.origin ?? ORIGIN, crossOrigin: false }));
  }
  private async head(flags: number, change: Change): Promise<Uint8Array> {
    return join(await sha256(encoder.encode(change.rpId ?? RP)), Uint8Array.of(change.flags ?? flags, 0, 0, this.counter >> 8, this.counter & 255));
  }

  async register(challenge: string, change: Change = {}) {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey) as JsonWebKey;
    const coordinate = (s: string): Uint8Array => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
    const cose = join(header(5, 5), Uint8Array.of(1, 2, 3, 0x26, 0x20, 1, 0x21), bytes(coordinate(jwk.x!)), Uint8Array.of(0x22), bytes(coordinate(jwk.y!)));
    const authData = join(await this.head(0x45, change), new Uint8Array(16), Uint8Array.of(this.id.length >> 8, this.id.length & 255), this.id, cose);
    const attestationObject = join(header(5, 3), text('fmt'), text('none'), text('attStmt'), header(5, 0), text('authData'), bytes(authData));
    return { id: this.credentialId, rawId: this.credentialId, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(this.client('webauthn.create', challenge, change)), attestationObject: b64(attestationObject), transports: ['internal'] } };
  }

  async sign(challenge: string, change: Change = {}) {
    this.counter++;
    const client = this.client('webauthn.get', challenge, change), authData = await this.head(0x05, change);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, join(authData, await sha256(client))));
    return { id: this.credentialId, rawId: this.credentialId, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(client), authenticatorData: b64(authData), signature: b64(der(raw)), ...(change.userHandle !== undefined && { userHandle: change.userHandle }) } };
  }
}
