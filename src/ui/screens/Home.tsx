import { useState } from 'preact/hooks';
import { call, type Me, problemOf } from '../api';
import { Failure, go, useBusy, useText } from '../app';

/** Until the pages screen (S5): who is signed in, and the owner's switch. */
export function Home({ me, onChange }: { me: Me; onChange: () => void }) {
  const t = useText(), [busy, run] = useBusy(), [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | null>(null);
  const act = (what: () => Promise<unknown>) => run(async () => { setProblem(null); try { await what(); onChange(); } catch (error) { setProblem(problemOf(error)); } });
  return (
    <section class="card narrow">
      <h1>{t('signedIn', { name: me.name })}</h1>
      {me.isOwner && <p>{t(me.instance ? 'isOn' : 'isOff')}</p>}
      {me.isOwner && !me.instance && <button class="primary" disabled={busy} onClick={() => act(() => call('PUT', '/switches/instance', { on: true }))}>{t('turnOn')}</button>}
      {me.instance && <p class="muted">{t('soon')}</p>}
      {me.instance && <button class="plain wide" onClick={() => go('/approve')}>{t('approveTitle')}</button>}
      <button class="plain wide" disabled={busy} onClick={() => act(() => call('DELETE', '/sessions/current'))}>{t('signOut')}</button>
      {problem && <Failure>{t(problem)}</Failure>}
    </section>
  );
}
