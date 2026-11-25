import { useEffect, useState } from 'preact/hooks';
import { call, CallError, problemOf } from '../api';
import { Failure, go, Heading, useBusy, useText } from '../app';

interface Request { id: string; secret: string; code: string; expiresAt: number }

/** This device asks to be signed in from another one. */
export function AskDevice({ onDone }: { onDone: () => void }) {
  const t = useText(), [busy, run] = useBusy(), [request, setRequest] = useState<Request | 'over' | 'offline' | 'wait' | 'failed' | null>(null);
  const start = async () => {
    setRequest(null);
    // Counted by this device's own clock, which may differ from the server's.
    try { setRequest({ ...await call<Request>('POST', '/device'), expiresAt: Date.now() + 300_000 }); } catch (error) { setRequest(problemOf(error)); }
  };
  useEffect(() => { void start(); }, []);
  useEffect(() => {
    if (request === null || typeof request === 'string') return;
    let stopped = false, timer = 0, pause = 3000;
    const ask = async () => {
      try {
        if (await call<'waiting' | undefined>('POST', '/device/claim', { id: request.id, secret: request.secret }) === undefined) { if (!stopped) onDone(); return; }
        pause = 3000;
      } catch (error) {
        if (error instanceof CallError && error.status === 404) { if (!stopped) setRequest('over'); return; }
        pause = Math.min(pause * 2, 30_000);
      }
      if (stopped) return;
      if (Date.now() >= request.expiresAt) setRequest('over');
      else timer = setTimeout(() => void ask(), Math.min(pause, request.expiresAt - Date.now() + 500)) as unknown as number;
    };
    timer = setTimeout(() => void ask(), pause) as unknown as number;
    return () => { stopped = true; clearTimeout(timer); };
  }, [request]);
  return (
    <section class="card narrow">
      <Heading>{t('fromOther')}</Heading>
      <div aria-live="polite">
        {request === null && <p class="muted">{t('loading')}</p>}
        {typeof request === 'string' && request !== 'over' && <Failure>{t(request)}</Failure>}
        {request === 'over' && <p>{t('codeOver')}</p>}
        {request !== null && typeof request !== 'string' && (
          <>
            <p>{t('codeHere', { url: `${location.origin}/approve` })}</p>
            <p class="code" dir="ltr">{request.code}</p>
            <p class="muted">{t('codeEnds')}</p>
          </>
        )}
      </div>
      {typeof request === 'string' && <button class="primary" disabled={busy} onClick={() => run(start)}>{t('newCode')}</button>}
      <button class="plain wide" onClick={() => go('/')}>{t('back')}</button>
    </section>
  );
}

/** A signed-in person signs in another device: types its code, sees what it is, approves. */
export function ApproveDevice({ onSignedOut }: { onSignedOut: () => void }) {
  const t = useText(), [busy, run] = useBusy(), [code, setCode] = useState(''), [device, setDevice] = useState<{ id: string; label: string } | null>(null), [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const step = (work: () => Promise<void>) => run(async () => {
    setProblem(null);
    try { await work(); }
    catch (error) {
      if (error instanceof CallError && error.status === 401) { onSignedOut(); return; }
      const bad = error instanceof CallError && error.status === 404;
      // Only a code that no longer works starts over; after any other failure the same step can be tried again.
      if (bad) setDevice(null);
      setProblem(t(bad ? 'badCode' : problemOf(error)));
    }
  });
  return (
    <section class="card narrow">
      {done ? <><Heading key="done">{t('approveTitle')}</Heading><p role="status">{t('approved')}</p></> : device === null ? (
        <form onSubmit={(event) => { event.preventDefault(); step(async () => setDevice(await call('POST', '/device/look', { code }))); }}>
          <Heading key="code">{t('approveTitle')}</Heading>
          <label class="muted" for="code">{t('approveHelp')}</label>
          <input id="code" class="field code" dir="ltr" autocomplete="off" autocapitalize="characters" spellcheck={false} maxLength={40} required value={code} onInput={(event) => setCode(event.currentTarget.value)} />
          <p class="muted">{t('approveWarn')}</p>
          <button class="primary" disabled={busy}>{t('next')}</button>
        </form>
      ) : (
        <>
          <Heading key="ask">{t('approveAsk', { label: device.label })}</Heading>
          <p class="muted">{t('approveWarn')}</p>
          <button class="primary" disabled={busy} onClick={() => step(async () => { await call('POST', '/device/approve', { id: device.id, code }); setDone(true); })}>{t('approve')}</button>
        </>
      )}
      {problem && <Failure>{problem}</Failure>}
      <button class="plain wide" onClick={() => go('/')}>{t('back')}</button>
    </section>
  );
}
