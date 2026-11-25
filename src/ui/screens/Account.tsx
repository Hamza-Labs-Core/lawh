import { useState } from 'preact/hooks';
import { call, type Me, problemOf } from '../api';
import { Failure, Fill, go, Heading, Link, useBusy, useText } from '../app';

/** Who is signed in, their other devices, and the owner's switch. */
export function Account({ me, onChange }: { me: Me; onChange: () => void }) {
  const t = useText(), [busy, run] = useBusy(), [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | null>(null);
  const act = (what: () => Promise<unknown>) => run(async () => { setProblem(null); try { await what(); onChange(); } catch (error) { setProblem(problemOf(error)); } });
  return (
    <section class="card narrow">
      <Heading><Fill text="signedIn" name={me.name} /></Heading>
      {me.isOwner && <p>{t(me.instance ? 'isOn' : 'isOff')}</p>}
      {me.isOwner && !me.instance && <button class="primary" disabled={busy} onClick={() => act(() => call('PUT', '/switches/instance', { on: true }))}>{t('turnOn')}</button>}
      {me.instance && <Link class="primary as-button" to="/">{t('pages')}</Link>}
      {me.instance && <button class="plain wide" onClick={() => go('/approve')}>{t('approveTitle')}</button>}
      <button class="plain wide" disabled={busy} onClick={() => act(() => call('DELETE', '/sessions/current'))}>{t('signOut')}</button>
      {problem && <Failure>{t(problem)}</Failure>}
    </section>
  );
}
