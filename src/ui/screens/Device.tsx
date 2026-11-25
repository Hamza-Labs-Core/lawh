import { useEffect, useState } from 'preact/hooks';
import { call, CallError, problemOf } from '../api';
import { Failure, go, useBusy, useText } from '../app';

interface Request { id: string; secret: string; code: string; expiresAt: number }

/** This device asks to be signed in from another one. */
export function AskDevice({ onDone }: { onDone: () => void }) {
  const t = useText(), [request, setRequest] = useState<Request | 'over' | 'offline' | 'wait' | 'failed' | null>(null);
  const start = async () => {
    setRequest(null);
    try { setRequest(await call<Request>('POST', '/device')); } catch (error) { setRequest(problemOf(error)); }
  };
  useEffect(() => { void start(); }, []);
  useEffect(() => {
    if (request === null || typeof request === 'string') return;
    let stopped = false, timer = 0;
    const ask = async () => {
      try {
        if (await call<'waiting' | undefined>('POST', '/device/claim', { id: request.id, secret: request.secret }) === undefined) { if (!stopped) onDone(); return; }
      } catch (error) {
        if (error instanceof CallError && error.status === 404) { if (!stopped) setRequest('over'); return; }
      }
      if (!stopped) timer = setTimeout(() => void ask(), 3000) as unknown as number;
    };
    timer = setTimeout(() => void ask(), 3000) as unknown as number;
    return () => { stopped = true; clearTimeout(timer); };
  }, [request]);
  return (
    <section class="card narrow">
      <h1>{t('fromOther')}</h1>
      {request === null && <p class="muted">{t('loading')}</p>}
      {typeof request === 'string' && request !== 'over' && <Failure>{t(request)}</Failure>}
      {request === 'over' && <p>{t('codeOver')}</p>}
      {request !== null && typeof request !== 'string' && (
        <>
          <p>{t('codeHere', { url: `${location.origin}/approve` })}</p>
          <p class="code" dir="ltr" aria-label={t('code')}>{request.code}</p>
          <p class="muted">{t('codeEnds')}</p>
        </>
      )}
      {typeof request === 'string' && <button class="primary" onClick={() => void start()}>{t('newCode')}</button>}
      <button class="plain wide" onClick={() => go('/')}>{t('back')}</button>
    </section>
  );
}

/** A signed-in person signs in another device: types its code, sees what it is, approves. */
export function ApproveDevice() {
  const t = useText(), [busy, run] = useBusy(), [code, setCode] = useState(''), [label, setLabel] = useState<string | null>(null), [done, setDone] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const step = (path: string, then: (result: { label: string } | undefined) => void) => run(async () => {
    setProblem(null);
    try { then(await call('POST', path, { code })); }
    catch (error) {
      setLabel(null);
      setProblem(t(error instanceof CallError && error.status === 404 ? 'badCode' : problemOf(error)));
    }
  });
  return (
    <section class="card narrow">
      <h1>{t('approveTitle')}</h1>
      {done ? <p role="status">{t('approved')}</p> : label === null ? (
        <form onSubmit={(event) => { event.preventDefault(); step('/device/look', (result) => setLabel(result!.label)); }}>
          <label class="muted" for="code">{t('approveHelp')}</label>
          <input id="code" class="field code" dir="ltr" autocomplete="off" autocapitalize="characters" spellcheck={false} maxLength={12} required value={code} onInput={(event) => setCode(event.currentTarget.value)} />
          <p class="muted">{t('approveWarn')}</p>
          <button class="primary" disabled={busy}>{t('next')}</button>
        </form>
      ) : (
        <>
          <h2>{t('approveAsk', { label })}</h2>
          <p class="muted">{t('approveWarn')}</p>
          <button class="primary" disabled={busy} onClick={() => step('/device/approve', () => setDone(true))}>{t('approve')}</button>
        </>
      )}
      {problem && <Failure>{problem}</Failure>}
      <button class="plain wide" onClick={() => go('/')}>{t('back')}</button>
    </section>
  );
}
