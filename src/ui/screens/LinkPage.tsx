import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'preact/hooks';
import { call, CallError, problemOf } from '../api';
import { Failure, Fill, Heading, useBusy, useText } from '../app';
import type { Key } from '../i18n';

interface Offer { challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON']; link: { kind: 'owner' | 'invite' | 'reset'; name: string; team: string | null; level: number | null; inviter: string | null } }

/** Setup, invite and reset links. The token is after the `#`, so it never reaches a server in an address. */
export function LinkPage({ token, onDone }: { token: string; onDone: (kind: 'owner' | 'invite' | 'reset') => void }) {
  const t = useText(), [busy, run] = useBusy(), [link, setLink] = useState<Offer['link'] | 'bad' | 'offline' | 'wait' | 'failed' | null>(null), [problem, setProblem] = useState<string | null>(null);
  const fetchOffer = () => call<Offer>('POST', '/link/options', { token });
  const load = async () => {
    setLink(null);
    try { setLink((await fetchOffer()).link); }
    catch (error) { setLink(error instanceof CallError && error.status === 404 ? 'bad' : problemOf(error)); }
  };
  useEffect(() => { void load(); }, [token]);
  if (link === null) return <section class="card narrow"><p class="muted" role="status">{t('loading')}</p></section>;
  if (link === 'bad') return <section class="card narrow"><Heading class="brand">{t('app')}</Heading><p role="status">{t('badLink')}</p></section>;
  if (typeof link === 'string') return <section class="card narrow"><Failure>{t(link)}</Failure><button class="plain wide" onClick={() => void load()}>{t('retry')}</button></section>;
  const register = async () => {
    setProblem(null);
    try {
      // A challenge made now: one from when the page opened may be old or used, and the new passkey would be lost.
      const { challengeId, options } = await fetchOffer();
      await call('POST', '/link', { token, challengeId, response: await startRegistration({ optionsJSON: options }) });
      onDone(link.kind);
    } catch (error) {
      if (error instanceof CallError && error.status === 404) setLink('bad');
      // Closing the browser's own window is no failure to show.
      else if (!(error instanceof Error && error.name === 'NotAllowedError')) setProblem(t(problemOf(error)));
    }
  };
  return (
    <section class="card narrow">
      <p class="logo">{t('app')}</p>
      <Heading><Fill text="welcome" name={link.name} /></Heading>
      <p>{link.kind === 'invite' ? <Fill text="inviteLink" inviter={link.inviter ?? ''} team={link.team ?? ''} level={t(`level${link.level}` as Key)} /> : t(link.kind === 'owner' ? 'ownerLink' : 'resetLink')}</p>
      {browserSupportsWebAuthn()
        ? <><button class="primary" disabled={busy} onClick={() => run(register)}>{t(link.kind === 'invite' ? 'join' : 'create')}</button><p class="muted">{t('passkeyHelp')}</p></>
        : <p>{t('noPasskeysHere')}</p>}
      {problem && <Failure>{problem}</Failure>}
    </section>
  );
}
