import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, CallError, type Me } from './api';
import { Failure, go, Link, SettingsProvider, TopBar, useSettings, useText } from './app';
import { digits } from './i18n';
import { ApproveDevice, AskDevice } from './screens/Device';
import { Account } from './screens/Account';
import { Connect } from './screens/Connect';
import { Settings } from './screens/Settings';
import { Comments } from './screens/Comments';
import { Decisions } from './screens/Decisions';
import { Library } from './screens/Library';
import { LinkPage } from './screens/LinkPage';
import { PageView } from './screens/PageView';
import { SignIn } from './screens/SignIn';

// Taken out of the address at once, so it stays out of the history and of anything that copies the address.
let linkToken = location.pathname === '/link' ? location.hash.slice(1) : '';
if (linkToken) history.replaceState(null, '', '/link');

/** Where to go. On a phone it is at the bottom, in reach of a thumb. */
function Nav({ path }: { path: string }) {
  const t = useText(), { lang } = useSettings(), [waiting, setWaiting] = useState<{ count: number; more: boolean } | null>(null);
  // After an answer at once (replacing any older request); on moving around or coming back, reuse a pending one and wait a minute after a reply.
  const counted = useRef(0), inFlight = useRef<AbortController | null>(null);
  const load = (force: boolean) => {
    if (!force && (inFlight.current || Date.now() - counted.current <= 60_000)) return;
    inFlight.current?.abort();
    const stop = new AbortController();
    inFlight.current = stop;
    call<{ count: number; more: boolean }>('GET', '/decisions/count', undefined, stop.signal).then(
      (next) => { if (inFlight.current === stop) { inFlight.current = null; counted.current = Date.now(); setWaiting(next); } },
      () => { if (inFlight.current === stop) inFlight.current = null; },
    );
  };
  useEffect(() => {
    const onChanged = () => load(true);
    const onVisible = () => { if (document.visibilityState === 'visible') load(false); };
    addEventListener('lawh:decisions', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => { inFlight.current?.abort(); inFlight.current = null; removeEventListener('lawh:decisions', onChanged); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  useEffect(() => { load(false); }, [path]);
  const n = waiting ? digits(lang, waiting.count) + (waiting.more ? '+' : '') : '';
  return (
    <nav class="places" aria-label={t('app')}>
      <Link to="/" current={path === '/' || path.startsWith('/p/')}>{t('pages')}</Link>
      <Link to="/decisions" current={path === '/decisions'}>{t('decisions')}{waiting !== null && waiting.count > 0 && <> <span class="badge">{n}</span></>}</Link>
      <Link to="/comments" current={path === '/comments'}>{t('comments')}</Link>
      <Link to="/settings" current={path.startsWith('/settings')}>{t('settings')}</Link>
    </nav>
  );
}

function App() {
  const t = useText(), [place, setPlace] = useState({ path: location.pathname, search: location.search }), [me, setMe] = useState<Me | 'nobody' | 'failed' | null>(null);
  const load = async () => {
    try { setMe(await call<Me>('GET', '/me')); }
    catch (error) { setMe(error instanceof CallError && (error.status === 401 || error.status === 404) ? 'nobody' : 'failed'); }
  };
  useEffect(() => {
    void load();
    const onMove = () => setPlace({ path: location.pathname, search: location.search });
    const onOut = () => setMe('nobody');
    addEventListener('popstate', onMove);
    addEventListener('lawh:signed-out', onOut);
    return () => { removeEventListener('popstate', onMove); removeEventListener('lawh:signed-out', onOut); };
  }, []);
  const swReady = typeof me === 'object' && me !== null && me.instance;
  useEffect(() => {
    if (!swReady || !('serviceWorker' in navigator)) return;
    const register = () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined); };
    if (document.readyState === 'complete') { register(); return; }
    addEventListener('load', register, { once: true });
    return () => removeEventListener('load', register);
  }, [swReady]);
  // The link or code is used: Back must not return to it.
  const arrive = (after = '/') => { linkToken = ''; go(after, true); setMe(null); void load(); };
  const { path, search } = place, reading = /^\/p\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(path);
  let screen;
  if (path === '/link') screen = <LinkPage token={linkToken} onDone={(recovery) => arrive(recovery ? '/settings/agents?reset=1' : '/')} />;
  else if (me === null) screen = <section class="card narrow"><p class="muted">{t('loading')}</p></section>;
  else if (me === 'failed') screen = <section class="card narrow"><Failure>{t('offline')}</Failure><button class="plain wide" onClick={() => { setMe(null); void load(); }}>{t('retry')}</button></section>;
  else if (me === 'nobody') screen = path === '/device' ? <AskDevice onDone={arrive} /> : <SignIn onDone={() => { setMe(null); void load(); }} />;
  else if (path === '/approve') screen = <ApproveDevice onSignedOut={() => { setMe(null); void load(); }} />;
  else if (!me.instance) screen = <Account me={me} onChange={() => void load()} />;
  else if (path === '/connect') screen = <Connect me={me} onSignedOut={() => { setMe(null); void load(); }} />;
  else if (path.startsWith('/settings')) screen = <Settings path={path} search={search} me={me} onChange={() => void load()} />;
  else if (reading) screen = <PageView project={reading[1]!} slug={reading[2]!} search={search} me={me} />;
  else if (path === '/comments') screen = <Comments me={me} />;
  else if (path === '/decisions') screen = <Decisions search={search} me={me} />;
  else screen = <Library search={search} me={me} />;
  return <><TopBar>{typeof me === 'object' && me !== null && me.instance && <Nav path={path} />}</TopBar>{/* A new screen starts over; the link page doesn't depend on who is signed in. */}<main key={path === '/link' ? path : path.startsWith('/settings') && typeof me === 'object' && me ? `/settings ${me.id}` : `${path} ${typeof me === 'object' && me ? me.id : me}`}>{screen}</main></>;
}

render(<SettingsProvider><App /></SettingsProvider>, document.getElementById('app')!);
