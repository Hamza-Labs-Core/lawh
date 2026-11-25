import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call, CallError, type Me } from './api';
import { Failure, go, Link, SettingsProvider, TopBar, useText } from './app';
import { ApproveDevice, AskDevice } from './screens/Device';
import { Account } from './screens/Account';
import { Library } from './screens/Library';
import { LinkPage } from './screens/LinkPage';
import { PageView } from './screens/PageView';
import { SignIn } from './screens/SignIn';

// Taken out of the address at once, so it stays out of the history and of anything that copies the address.
let linkToken = location.pathname === '/link' ? location.hash.slice(1) : '';
if (linkToken) history.replaceState(null, '', '/link');

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
  // The link or code is used: Back must not return to it.
  const arrive = () => { linkToken = ''; go('/', true); setMe(null); void load(); };
  const { path, search } = place, reading = /^\/p\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(path);
  let screen;
  if (path === '/link') screen = <LinkPage token={linkToken} onDone={arrive} />;
  else if (me === null) screen = <section class="card narrow"><p class="muted">{t('loading')}</p></section>;
  else if (me === 'failed') screen = <section class="card narrow"><Failure>{t('offline')}</Failure><button class="plain wide" onClick={() => { setMe(null); void load(); }}>{t('retry')}</button></section>;
  else if (me === 'nobody') screen = path === '/device' ? <AskDevice onDone={arrive} /> : <SignIn onDone={() => { setMe(null); void load(); }} />;
  else if (path === '/approve') screen = <ApproveDevice onSignedOut={() => { setMe(null); void load(); }} />;
  else if (path === '/account' || !me.instance) screen = <Account me={me} onChange={() => void load()} />;
  else if (reading) screen = <PageView project={reading[1]!} slug={reading[2]!} search={search} />;
  else screen = <Library search={search} />;
  return <><TopBar>{typeof me === 'object' && me !== null && <Link class="plain as-button" to="/account" current={path === '/account'}>{t('account')}</Link>}</TopBar>{/* A new screen starts over; the link page doesn't depend on who is signed in. */}<main class={reading ? 'reading' : undefined} key={path === '/link' ? path : `${path} ${typeof me === 'object' && me ? me.id : me}`}>{screen}</main></>;
}

render(<SettingsProvider><App /></SettingsProvider>, document.getElementById('app')!);
