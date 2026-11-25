import { useEffect, useRef, useState } from 'preact/hooks';
import { call, CallError, type Listed, problemOf, type Reading, type Version } from '../api';
import { Failure, Fill, go, Heading, Link, useBusy, useSettings, useText, wasInside } from '../app';
import { type Media, readBridgeMessage } from '../bridgeHost';
import { day, digits, translate } from '../i18n';
import { StatusMark } from './Library';
import { Viewer } from './Viewer';

const CALM = { until: 0, wait: 300, pushy: false, quick: 0 };

/** One version of a page, in its sandboxed frame, with the app's own bar around it. */
export function PageView({ project, slug, search }: { project: string; slug: string; search: string }) {
  const t = useText(), { lang, mode } = useSettings(), asked = new URLSearchParams(search).get('v'), path = `/projects/${project}/pages/${slug}`;
  const [page, setPage] = useState<Reading | 'gone' | 'offline' | 'wait' | 'failed' | null>(null), [tries, setTries] = useState(0), [slow, setSlow] = useState(false), [versions, setVersions] = useState<HTMLElement | null>(null), [link, setLink] = useState<string | null>(null), [media, setMedia] = useState<Media | null>(null);
  const frame = useRef<HTMLIFrameElement>(null), ready = useRef(false), theme = useRef({ mode, lang });
  theme.current = { mode, lang };
  // A page can send messages whenever it likes, so what it wants to open is shown only right after the person did
  // something (the browser knows, and a page can't pretend), and only when nothing else is open: it can't change an
  // address under a finger. One that keeps asking after a close waits longer each time, so it can't trap the tab; a
  // person who opens links and pictures one by one isn't held up.
  const quiet = useRef({ ...CALM }), dialogOpen = useRef(false);
  dialogOpen.current = link !== null || versions !== null || media !== null;
  // The picture the viewer asked for; what comes unasked while it is open is not shown.
  const wanted = useRef<number | null>(null), shown = useRef<number | null>(null);
  shown.current = media?.index ?? null;
  const moveTo = (index: number) => { wanted.current = index; frame.current?.contentWindow?.postMessage({ type: 'lawh:show-media', index }, '*'); };
  const closeMedia = () => {
    const index = shown.current;
    pause(); setMedia(null); wanted.current = null;
    // Back to the picture it was opened from.
    frame.current?.focus();
    frame.current?.contentWindow?.postMessage({ type: 'lawh:focus-media', index }, '*');
  };
  const pause = () => {
    const { wait, pushy, quick } = quiet.current, next = pushy ? Math.min(wait * 2, 60_000) : CALM.wait;
    quiet.current = { until: Date.now() + next, wait: next, pushy: false, quick };
  };
  const cancelLink = () => { pause(); setLink(null); };
  const openedLink = () => { quiet.current = { ...CALM }; setLink(null); };
  const closeVersions = () => {
    // Never shortens a pause the page has earned.
    if (quiet.current.pushy) pause(); else quiet.current.until = Math.max(quiet.current.until, Date.now() + CALM.wait);
    setVersions(null);
  };
  // The frame's origin is opaque, so there is no name to send to; nothing in the message is secret.
  const sendTheme = () => frame.current?.contentWindow?.postMessage({ type: 'lawh:theme', ...theme.current }, '*');

  useEffect(() => {
    const stop = new AbortController();
    setPage(null); setSlow(false); setVersions(null); setLink(null); setMedia(null); wanted.current = null; ready.current = false; quiet.current = { ...CALM };
    // The theme and language are in the address only for the first paint; changes are sent to the page.
    call<Reading>('GET', `${path}?${new URLSearchParams({ mode, lang, ...(asked && { v: asked }) })}`, undefined, stop.signal)
      .then(setPage, (error: unknown) => { if (!stop.signal.aborted) setPage(error instanceof CallError && error.status === 404 ? 'gone' : problemOf(error)); });
    return () => stop.abort();
  }, [path, asked, tries]);

  const url = page !== null && typeof page === 'object' ? page.frame : null;
  useEffect(() => {
    if (url === null) return;
    const timer = setTimeout(() => { if (!ready.current) setSlow(true); }, 10_000);
    return () => clearTimeout(timer);
  }, [url]);

  // From the start: a page in the cache can speak before an effect that waits for its address has run.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = readBridgeMessage(event, frame.current?.contentWindow);
      if (message?.type === 'open-media' && shown.current !== null) {
        if (message.index === wanted.current) { wanted.current = null; setMedia(message); }
      } else if (message?.type === 'open-link' || message?.type === 'open-media') {
        const since = Date.now() - quiet.current.until;
        if (navigator.userActivation?.isActive === false) return;
        if (dialogOpen.current || since < 0) quiet.current.pushy = true;
        else {
          // The moment a pause ended, five times in a row: a timer, more likely than a finger.
          quiet.current.quick = quiet.current.until > 0 && since < 100 ? quiet.current.quick + 1 : 0;
          if (quiet.current.quick >= 5) quiet.current.pushy = true;
          dialogOpen.current = true;
          if (message.type === 'open-link') setLink(message.url); else setMedia(message);
        }
      }
      // The bridge listens now: what changed while the page loaded is sent again.
      if (message?.type === 'outline') { ready.current = true; setSlow(false); sendTheme(); }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

  useEffect(() => { sendTheme(); }, [mode, lang]);

  if (page === null) return <p class="muted" role="status">{t('loading')}</p>;
  if (page === 'gone') return <section class="card narrow"><Heading>{t('app')}</Heading><p role="status">{t('pageGone')}</p><Link class="plain as-button" to="/">{t('pages')}</Link></section>;
  if (typeof page === 'string') return <section class="card narrow"><Failure>{t(page)}</Failure><button class="plain wide" onClick={() => setTries(tries + 1)}>{t('retry')}</button></section>;
  const old = page.version.n !== page.currentVersion;
  return (
    <div class="reader">
      <div class="reader-bar">
        <button class="plain" onClick={() => (wasInside() ? history.back() : go('/'))}>{t('back')}</button>
        <div class="reader-title">
          <Heading><bdi lang={page.lang}>{page.title}</bdi></Heading>
          <p class="muted"><bdi>{page.project.name[lang]}</bdi>{lang === 'ar' ? '، ' : ', '}<Fill text="by" agent={page.version.publishedBy} date={day(lang, page.version.createdAt)} /></p>
        </div>
        <StatusMark status={page.status} />
        <button class="plain" aria-haspopup="dialog" onClick={(event) => setVersions(event.currentTarget)}><Fill text="version" n={digits(lang, page.version.n)} /></button>
      </div>
      {old && <p class="notice" role="status"><Fill text="oldVersion" n={digits(lang, page.version.n)} current={digits(lang, page.currentVersion)} /> <Link to={`/p/${project}/${slug}`}>{t('toCurrent')}</Link></p>}
      {slow && <p class="notice" role="status">{t('slow')} <button class="text" onClick={() => setTries(tries + 1)}>{t('reload')}</button></p>}
      <iframe key={page.frame} ref={frame} class="page-frame" title={translate(lang, 'pageFrame', { title: page.title })} sandbox="allow-scripts" referrerpolicy="no-referrer" src={page.frame} onLoad={sendTheme} />
      {versions && <Versions path={path} project={project} slug={slug} shown={page.version.n} current={page.currentVersion} returnTo={versions} onClose={closeVersions} />}
      {media !== null && <Viewer media={media} frameUrl={page.viewer} onMove={moveTo} onClose={closeMedia} />}
      {link !== null && <LeaveDialog url={link} returnTo={frame.current} onClose={cancelLink} onOpened={openedLink} />}
    </div>
  );
}

/** An in-app dialog. Escape and the area around it close it, and the focus returns to what opened it (Safari doesn't focus a clicked button). */
function Dialog({ title, returnTo, onClose, children }: { title: string; returnTo: HTMLElement | null; onClose: () => void; children: preact.ComponentChildren }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => { if (returnTo?.isConnected) returnTo.focus(); };
  }, []);
  return (
    <dialog ref={dialog} aria-label={title} onClose={onClose} onClick={(event) => { if (event.target === dialog.current) dialog.current?.close(); }}>
      <div class="dialog"><h2>{title}</h2>{children}</div>
    </dialog>
  );
}

function LeaveDialog({ url, returnTo, onClose, onOpened }: { url: string; returnTo: HTMLElement | null; onClose: () => void; onOpened: () => void }) {
  const t = useText();
  return (
    <Dialog title={t('leaveTitle')} returnTo={returnTo} onClose={onClose}>
      <p>{t('leaveHelp')}</p>
      <p class="address" dir="ltr">{url}</p>
      <div class="row">
        <button class="plain" onClick={onClose}>{t('cancel')}</button>
        <a class="primary as-button" href={url} target="_blank" rel="noopener noreferrer" onClick={onOpened}>{t('open')}</a>
      </div>
    </Dialog>
  );
}

function Versions({ path, project, slug, shown, current, returnTo, onClose }: { path: string; project: string; slug: string; shown: number; current: number; returnTo: HTMLElement | null; onClose: () => void }) {
  const t = useText(), { lang } = useSettings(), [busy, run] = useBusy(), [list, setList] = useState<Listed<Version> | null>(null), [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | null>(null);
  const load = () => run(async () => {
    setProblem(null);
    try {
      const next = await call<Listed<Version>>('GET', `${path}/versions${list?.next ? `?cursor=${list.next}` : ''}`);
      setList({ items: [...(list?.items ?? []), ...next.items], next: next.next });
    } catch (error) { setProblem(problemOf(error)); }
  });
  useEffect(load, []);
  return (
    <Dialog title={t('versions')} returnTo={returnTo} onClose={onClose}>
      {list === null && !problem && <p class="muted" role="status">{t('loading')}</p>}
      <ul class="versions">
        {list?.items.map((v) => (
          <li key={v.n}>
            <Link to={`/p/${project}/${slug}${v.n === current ? '' : `?v=${v.n}`}`} current={v.n === shown} onGo={v.n === shown ? onClose : undefined}>
              <strong><Fill text="version" n={digits(lang, v.n)} /></strong>{v.n === current && <span class="status decided">{t('current')}</span>}
              <span class="muted"><Fill text="by" agent={v.publishedBy} date={day(lang, v.createdAt)} /></span>
              {v.note && <span><bdi>{v.note}</bdi></span>}
            </Link>
          </li>
        ))}
      </ul>
      {problem && <Failure>{t(problem)}</Failure>}
      {(list?.next || problem) && <button class="plain wide" disabled={busy} onClick={load}>{t(problem ? 'retry' : 'more')}</button>}
      <button class="plain wide" onClick={onClose}>{t('close')}</button>
    </Dialog>
  );
}
