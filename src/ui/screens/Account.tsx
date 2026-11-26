import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'preact/hooks';
import { call, CallError, type Listed, type Me, problemOf } from '../api';
import { Failure, Fill, go, Heading, Link, useBusy, useSettings, useText } from '../app';
import { day } from '../i18n';

type Problem = 'offline' | 'wait' | 'failed' | 'lastPasskey';
interface Session { id: string; label: string; createdAt: number; lastSeenAt: number; current: boolean }
interface Passkey { id: string; label: string; createdAt: number; lastUsedAt: number | null }

/** Who is signed in, their devices and passkeys, and the owner's switch. `inside`: part of the settings screen. */
export function Account({ me, onChange, inside = false }: { me: Me; onChange: () => void; inside?: boolean }) {
  const t = useText(), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null), [asking, setAsking] = useState(false);
  const act = (what: () => Promise<unknown>) => run(async () => { setProblem(null); try { await what(); onChange(); } catch (error) { setProblem(problemOf(error)); } });
  const who = <Fill text="signedIn" name={me.name} />;
  return (
    <>
      <section class={inside ? 'card form' : 'card narrow'}>
        {inside ? <h2>{who}</h2> : <Heading>{who}</Heading>}
        {me.isOwner && <p>{t(me.instance ? 'isOn' : 'isOff')}</p>}
        {me.isOwner && !me.instance && <button class="primary" disabled={busy} onClick={() => act(() => call('PUT', '/switches/instance', { on: true }))}>{t('turnOn')}</button>}
        {me.instance && !inside && <Link class="primary as-button" to="/">{t('pages')}</Link>}
        {me.instance && <button class="plain wide" onClick={() => go('/approve')}>{t('approveTitle')}</button>}
        {me.isOwner && me.instance && inside && (asking
          ? <><p class="failure">{t('turnOffHelp')}</p><div class="row"><button class="plain" disabled={busy} onClick={() => act(() => call('PUT', '/switches/instance', { on: false }))}>{t('turnOffSure')}</button><button class="plain" disabled={busy} onClick={() => setAsking(false)}>{t('cancel')}</button></div></>
          : <button class="plain wide" onClick={() => setAsking(true)}>{t('turnOff')}</button>)}
        <button class="plain wide" disabled={busy} onClick={() => act(() => call('DELETE', '/sessions/current'))}>{t('signOut')}</button>
        {problem && <Failure>{t(problem)}</Failure>}
      </section>
      {inside && me.instance && <Devices />}
    </>
  );
}

function Devices() {
  const t = useText(), { lang } = useSettings(), [sessions, setSessions] = useState<Session[] | null>(null), [passkeys, setPasskeys] = useState<Passkey[] | null>(null), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null), [tries, setTries] = useState(0);
  useEffect(() => {
    const stop = new AbortController(), failed = (error: unknown) => { if (!stop.signal.aborted) setProblem(problemOf(error)); };
    setProblem(null);
    call<Listed<Session>>('GET', '/sessions', undefined, stop.signal).then((r) => setSessions(r.items), failed);
    call<Listed<Passkey>>('GET', '/passkeys', undefined, stop.signal).then((r) => setPasskeys(r.items), failed);
    return () => stop.abort();
  }, [tries]);
  const act = (what: () => Promise<unknown>) => run(async () => {
    setProblem(null);
    try { await what(); } catch (error) {
      // Closing the browser's own window is no failure to show.
      if (!(error instanceof Error && error.name === 'NotAllowedError')) setProblem(error instanceof CallError && error.status === 409 ? 'lastPasskey' : problemOf(error));
    }
  });
  const add = () => act(async () => {
    const { challengeId, options } = await call<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('POST', '/passkeys/options');
    await call('POST', '/passkeys', { challengeId, response: await startRegistration({ optionsJSON: options }) });
    setTries((n) => n + 1);
  });
  return (
    <>
      <section class="card form">
        <h2>{t('passkeys')}</h2>
        {passkeys === null && !problem && <p class="muted" role="status">{t('loading')}</p>}
        <ul class="rows">{passkeys?.map((k) => (
          <li key={k.id}><div><strong><bdi dir="auto">{k.label}</bdi></strong><p class="muted"><Fill text="addedOn" date={day(lang, k.createdAt)} />{lang === 'ar' ? '، ' : ', '}{k.lastUsedAt === null ? t('neverUsed') : <Fill text="lastUsed" date={day(lang, k.lastUsedAt)} />}</p></div>
            {passkeys.length > 1 && <button class="plain" disabled={busy} onClick={() => act(async () => { await call('DELETE', `/passkeys/${k.id}`); setPasskeys((now) => now && now.filter((o) => o.id !== k.id)); })}>{t('remove')}</button>}</li>
        ))}</ul>
        {browserSupportsWebAuthn() && <button class="plain wide" disabled={busy} onClick={add}>{t('addPasskey')}</button>}
      </section>
      <section class="card form">
        <h2>{t('devices')}</h2>
        <ul class="rows">{sessions?.map((s) => (
          <li key={s.id}><div><strong><bdi dir="auto">{s.label}</bdi></strong>{s.current && <> <span class="status decided">{t('thisDevice')}</span></>}<p class="muted"><Fill text="lastSeen" date={day(lang, s.lastSeenAt)} /></p></div>
            {!s.current && <button class="plain" disabled={busy} onClick={() => act(async () => { await call('DELETE', `/sessions/${s.id}`); setSessions((now) => now && now.filter((o) => o.id !== s.id)); })}>{t('endSession')}</button>}</li>
        ))}</ul>
        {problem && <><Failure>{t(problem)}</Failure>{(sessions === null || passkeys === null) && <button class="plain" onClick={() => setTries((n) => n + 1)}>{t('retry')}</button>}</>}
      </section>
    </>
  );
}
