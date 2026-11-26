import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useState } from 'preact/hooks';
import { call, problemOf } from '../api';
import { brandName, Failure, go, Heading, useBusy, useSettings, useText } from '../app';

export function SignIn({ onDone }: { onDone: () => void }) {
  const t = useText(), { lang } = useSettings(), [busy, run] = useBusy(), [problem, setProblem] = useState<string | null>(null), supported = browserSupportsWebAuthn();
  const signIn = async () => {
    setProblem(null);
    try {
      const { challengeId, options } = await call<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('POST', '/sign-in/options');
      await call('POST', '/sign-in', { challengeId, response: await startAuthentication({ optionsJSON: options }) });
      onDone();
    } catch (error) {
      // Closing the browser's own window is no failure to show.
      if (error instanceof Error && error.name === 'NotAllowedError') return;
      setProblem(t(problemOf(error)));
    }
  };
  return (
    <section class="card narrow">
      <Heading class="brand">{brandName(lang)}</Heading>
      <p class="muted">{t('tagline')}</p>
      {supported ? <button class="primary" disabled={busy} onClick={() => run(signIn)}>{t('signIn')}</button> : <p>{t('noPasskeys')}</p>}
      <button class="plain wide" onClick={() => go('/device')}>{t('fromOther')}</button>
      {problem && <Failure>{problem}</Failure>}
    </section>
  );
}
