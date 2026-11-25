import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call, CallError, type Me } from './api';
import { Failure, go, SettingsProvider, TopBar, useText } from './app';
import { ApproveDevice, AskDevice } from './screens/Device';
import { Home } from './screens/Home';
import { LinkPage } from './screens/LinkPage';
import { SignIn } from './screens/SignIn';

// Taken out of the address at once, so it stays out of the history and of anything that copies the address.
let linkToken = location.pathname === '/link' ? location.hash.slice(1) : '';
if (linkToken) history.replaceState(null, '', '/link');

function App() {
  const t = useText(), [path, setPath] = useState(location.pathname), [me, setMe] = useState<Me | 'nobody' | 'failed' | null>(null);
  const load = async () => {
    try { setMe(await call<Me>('GET', '/me')); }
    catch (error) { setMe(error instanceof CallError && (error.status === 401 || error.status === 404) ? 'nobody' : 'failed'); }
  };
  useEffect(() => {
    void load();
    const onMove = () => setPath(location.pathname);
    addEventListener('popstate', onMove);
    return () => removeEventListener('popstate', onMove);
  }, []);
  // The link or code is used: Back must not return to it.
  const arrive = () => { linkToken = ''; go('/', true); setMe(null); void load(); };
  let screen;
  if (path === '/link') screen = <LinkPage token={linkToken} onDone={arrive} />;
  else if (me === null) screen = <section class="card narrow"><p class="muted">{t('loading')}</p></section>;
  else if (me === 'failed') screen = <section class="card narrow"><Failure>{t('offline')}</Failure><button class="plain wide" onClick={() => { setMe(null); void load(); }}>{t('retry')}</button></section>;
  else if (me === 'nobody') screen = path === '/device' ? <AskDevice onDone={arrive} /> : <SignIn onDone={() => { setMe(null); void load(); }} />;
  else if (path === '/approve') screen = <ApproveDevice onSignedOut={() => { setMe(null); void load(); }} />;
  else screen = <Home me={me} onChange={() => void load()} />;
  return <><TopBar />{/* A new screen starts over; the link page doesn't depend on who is signed in. */}<main key={path === '/link' ? path : `${path} ${typeof me === 'object' && me ? me.id : me}`}>{screen}</main></>;
}

render(<SettingsProvider><App /></SettingsProvider>, document.getElementById('app')!);
