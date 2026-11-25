import { startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'preact/hooks';
import { call, CallError, problemOf } from '../api';
import { Failure, useBusy, useText } from '../app';
import type { Key } from '../i18n';

interface Offer { challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON']; link: { kind: 'owner' | 'invite' | 'reset'; name: string; team: string | null; level: number | null; inviter: string | null } }

/** Setup, invite and reset links. The token is after the `#`, so it never reaches a server in an address. */
export function LinkPage({ token, onDone }: { token: string; onDone: () => void }) {
  const t = useText(), [busy, run] = useBusy(), [offer, setOffer] = useState<Offer | 'bad' | 'offline' | 'wait' | 'failed' | null>(null), [problem, setProblem] = useState<string | null>(null);
  const load = async () => {
    setOffer(null);
    try { setOffer(await call<Offer>('POST', '/link/options', { token })); }
    catch (error) { setOffer(error instanceof CallError && error.status === 404 ? 'bad' : problemOf(error)); }
  };
  useEffect(() => { void load(); }, [token]);
  if (offer === null) return <section class="card narrow"><p class="muted">{t('loading')}</p></section>;
  if (offer === 'bad') return <section class="card narrow"><h1 class="brand">{t('app')}</h1><p>{t('badLink')}</p></section>;
  if (typeof offer === 'string') return <section class="card narrow"><Failure>{t(offer)}</Failure><button class="plain wide" onClick={() => void load()}>{t('retry')}</button></section>;
  const { link } = offer;
  const register = async () => {
    setProblem(null);
    try {
      await call('POST', '/link', { token, challengeId: offer.challengeId, response: await startRegistration({ optionsJSON: offer.options }) });
      onDone();
    } catch (error) {
      if (error instanceof CallError && error.status === 404) { setOffer('bad'); return; }
      if (!(error instanceof Error && error.name === 'NotAllowedError')) setProblem(t(problemOf(error)));
      // The challenge was used or is getting old: the next try needs a new one.
      await call<Offer>('POST', '/link/options', { token }).then(setOffer, () => undefined);
    }
  };
  return (
    <section class="card narrow">
      <h1 class="brand">{t('app')}</h1>
      <h2>{t('welcome', { name: link.name })}</h2>
      <p>{link.kind === 'invite' ? t('inviteLink', { inviter: link.inviter ?? '', team: link.team ?? '', level: t(`level${link.level}` as Key) }) : t(link.kind === 'owner' ? 'ownerLink' : 'resetLink')}</p>
      <button class="primary" disabled={busy} onClick={() => run(register)}>{t(link.kind === 'invite' ? 'join' : 'create')}</button>
      <p class="muted">{t('passkeyHelp')}</p>
      {problem && <Failure>{problem}</Failure>}
    </section>
  );
}
