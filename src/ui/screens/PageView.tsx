import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { call, CallError, type Decision, type Listed, type Me, problemOf, type Reading, type Version } from '../api';
import { Failure, Fill, go, Heading, Link, useBusy, useSettings, useText, wasInside } from '../app';
import { discard, type Media, readBridgeMessage } from '../bridgeHost';
import { day, digits, translate } from '../i18n';
import { DecisionList, left } from './Decisions';
import { StatusMark } from './Library';
import { taken, Viewer } from './Viewer';

const CALM = { closedAt: 0, again: 0 };

/** One version of a page, in its sandboxed frame, with the app's own bar around it. */
export function PageView({ project, slug, search, me }: { project: string; slug: string; search: string; me: Me }) {
  const t = useText(), { lang, mode } = useSettings(), asked = new URLSearchParams(search).get('v'), path = `/projects/${project}/pages/${slug}`;
  const [page, setPage] = useState<Reading | 'gone' | 'offline' | 'wait' | 'failed' | null>(null), [tries, setTries] = useState(0), [slow, setSlow] = useState(false), [versions, setVersions] = useState<HTMLElement | null>(null), [link, setLink] = useState<string | null>(null), [media, setMedia] = useState<Media | null>(null);
  const [asks, setAsks] = useState<{ items: Decision[]; answerers: number | null } | null>(null), [asksProblem, setAsksProblem] = useState<'offline' | 'wait' | 'failed' | null>(null), [asksTries, setAsksTries] = useState(0), [sheet, setSheet] = useState<HTMLElement | null>(null), wide = useWide();
  const frame = useRef<HTMLIFrameElement>(null), ready = useRef(false), theme = useRef({ mode, lang });
  theme.current = { mode, lang };
  // A page can send messages whenever it likes, so what it wants to open is shown only while the browser counts the
  // person as active and the page has the focus, and only when nothing else is open: it can't change an address under a
  // finger. A page can still claim the focus after a click in the app, and nothing tells that from a person for sure.
  // So one that comes back soon after it was closed is offered to be stopped, as browsers do with their own dialogs.
  const opening = useRef({ ...CALM }), dialogOpen = useRef(false), [blocked, setBlocked] = useState(false), [pushy, setPushy] = useState(false);
  const blockedNow = useRef(false), shown = useRef<number | null>(null), pressed = useRef(0), refocus = useRef(0);
  blockedNow.current = blocked;
  const open = link !== null || versions !== null || media !== null || (sheet !== null && !wide);
  dialogOpen.current = open;
  shown.current = media?.index ?? null;
  // A picture that is replaced before the viewer took it over is freed here.
  const held = useRef<Media | null>(null);
  const showMedia = (next: Media | null) => {
    if (held.current && !taken.has(held.current)) discard(held.current.picture);
    held.current = next;
    setMedia(next);
  };
  const closed = () => { opening.current.closedAt = Date.now(); };
  const mayOpen = (): boolean => {
    if (blockedNow.current) return false;
    const since = Date.now() - opening.current.closedAt;
    if (dialogOpen.current || since < 300) { opening.current.again++; return false; }
    // What was just pressed in the app was not meant for the page.
    if (Date.now() - pressed.current < 600) return false;
    if (navigator.userActivation?.isActive === false || document.activeElement !== frame.current) return false;
    // Far past the seconds in which closing something counts as activity, and never forgotten at once.
    opening.current.again = since < 15_000 ? opening.current.again + 1 : Math.max(0, opening.current.again - 1);
    setPushy(opening.current.again >= 3);
    dialogOpen.current = true;
    return true;
  };
  // The picture the viewer asked for last; nothing else is shown while it is open.
  const wanted = useRef<number | null>(null);
  const moveTo = (index: number) => { wanted.current = index; frame.current?.contentWindow?.postMessage({ type: 'lawh:show-media', index }, '*'); };
  const closeMedia = () => {
    const index = shown.current;
    closed(); showMedia(null); wanted.current = null;
    // Back to the picture it was opened from, once the dialog is gone.
    refocus.current = setTimeout(() => { frame.current?.focus(); frame.current?.contentWindow?.postMessage({ type: 'lawh:focus-media', index }, '*'); }) as unknown as number;
  };
  const cancelLink = () => { closed(); setLink(null); };
  const openedLink = () => { opening.current = { ...CALM }; setLink(null); };
  const closeSheet = () => { closed(); setSheet(null); };
  const closeVersions = () => { closed(); setVersions(null); };
  const block = pushy ? () => { setBlocked(true); setPushy(false); clearTimeout(refocus.current); showMedia(null); setLink(null); wanted.current = null; } : null;
  // The frame's origin is opaque, so there is no name to send to; nothing in the message is secret.
  const sendTheme = () => frame.current?.contentWindow?.postMessage({ type: 'lawh:theme', ...theme.current }, '*');

  useEffect(() => {
    const stop = new AbortController();
    setPage(null); setSlow(false); setVersions(null); setLink(null); showMedia(null); wanted.current = null; clearTimeout(refocus.current); ready.current = false; opening.current = { ...CALM }; setBlocked(false); setPushy(false);
    // The theme and language are in the address only for the first paint; changes are sent to the page.
    call<Reading>('GET', `${path}?${new URLSearchParams({ mode, lang, ...(asked && { v: asked }) })}`, undefined, stop.signal)
      .then(setPage, (error: unknown) => { if (!stop.signal.aborted) setPage(error instanceof CallError && error.status === 404 ? 'gone' : problemOf(error)); });
    return () => stop.abort();
  }, [path, asked, tries]);

  // The page's questions, whichever version is shown.
  useEffect(() => {
    const stop = new AbortController();
    setAsksProblem(null);
    call<{ items: Decision[]; answerers: number | null }>('GET', `${path}/decisions`, undefined, stop.signal)
      .then(setAsks, (error: unknown) => { if (!stop.signal.aborted && !(error instanceof CallError && error.status === 404)) setAsksProblem(problemOf(error)); });
    return () => stop.abort();
  }, [path, tries, asksTries]);
  const answeredOne = (next: Decision) => {
    setAsks((now) => now && { ...now, items: now.items.map((d) => (d.id === next.id ? next : d)) });
    // The last answer can decide the page.
    setPage((now) => (now !== null && typeof now === 'object' ? { ...now, status: next.page.status } : now));
  };

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
        if (message.asked && message.index === wanted.current) { wanted.current = null; showMedia(message); } else {
          // An answer to an earlier press of an arrow is no fault of the page.
          if (!message.asked) opening.current.again++;
          discard(message.picture);
        }
      } else if (message?.type === 'open-media') {
        // A late answer, after the viewer was closed, opens nothing and counts for nothing.
        if (!message.asked && mayOpen()) showMedia(message); else discard(message.picture);
      } else if (message?.type === 'open-link' && mayOpen()) setLink(message.url);
      // The bridge listens now: what changed while the page loaded is sent again.
      if (message?.type === 'outline') { ready.current = true; setSlow(false); sendTheme(); }
    };
    const onPress = () => { pressed.current = Date.now(); };
    addEventListener('message', onMessage);
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'keyup']) addEventListener(type, onPress, true);
    return () => {
      removeEventListener('message', onMessage);
      for (const type of ['pointerdown', 'pointerup', 'keydown', 'keyup']) removeEventListener(type, onPress, true);
      clearTimeout(refocus.current);
      if (held.current && !taken.has(held.current)) discard(held.current.picture);
    };
  }, []);

  // WebKit lets a page take the keyboard from behind an open dialog: it's taken back, so Escape works and no key goes to the page.
  useLayoutEffect(() => {
    if (!open) return;
    // The window loses the focus to a frame, sometimes while a button of the dialog still counts as focused.
    let away = false;
    const keep = () => {
      // The one on top.
      const dialog = [...document.querySelectorAll<HTMLElement>('dialog[open]')].at(-1), at = document.activeElement;
      if (!dialog || !document.hasFocus() || (dialog.contains(at) && (!away || at?.tagName === 'IFRAME'))) return;
      away = false;
      if (at instanceof HTMLElement) at.blur();
      focus();
      (at !== dialog && dialog.contains(at) && at instanceof HTMLElement ? at : dialog.querySelector('button'))?.focus();
    };
    // Not at once: WebKit hands the keyboard over only after this.
    const onBlur = () => { away = true; }, onFocus = () => { away = false; };
    const timer = setInterval(keep, 100);
    addEventListener('blur', onBlur);
    addEventListener('focus', onFocus);
    return () => { clearInterval(timer); removeEventListener('blur', onBlur); removeEventListener('focus', onFocus); };
  }, [open]);

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
      {asksProblem && <div class="notice"><Failure>{t(asksProblem)}</Failure><button class="text" onClick={() => setAsksTries(asksTries + 1)}>{t('retry')}</button></div>}
      <div class="reader-body">
        <iframe key={page.frame} ref={frame} class="page-frame" title={translate(lang, 'pageFrame', { title: page.title })} sandbox="allow-scripts" referrerpolicy="no-referrer" src={page.frame} onLoad={sendTheme} />
        {asks !== null && asks.items.length > 0 && wide && <aside class="reader-side" aria-label={t('decisions')} tabIndex={0}><h2>{t('decisions')}</h2><DecisionList {...asks} me={me} onChange={answeredOne} /></aside>}
      </div>
      {asks !== null && asks.items.length > 0 && !wide && (
        <div class="to-panel"><button class="primary" aria-haspopup="dialog" onClick={(event) => setSheet(event.currentTarget)}>{left(asks.items, me) > 0 ? <Fill text="toMake" n={digits(lang, left(asks.items, me))} /> : t('decisions')}</button></div>
      )}
      {asks !== null && sheet !== null && !wide && (
        <Dialog class="sheet" title={t('decisions')} returnTo={sheet} onClose={closeSheet} closer={t('close')}>
          <DecisionList {...asks} me={me} onChange={answeredOne} />
        </Dialog>
      )}
      {versions && <Versions path={path} project={project} slug={slug} shown={page.version.n} current={page.currentVersion} returnTo={versions} onClose={closeVersions} />}
      {media !== null && <Viewer media={media} frameUrl={page.viewer} onMove={moveTo} onClose={closeMedia} onBlock={block} />}
      {link !== null && <LeaveDialog url={link} returnTo={frame.current} onClose={cancelLink} onOpened={openedLink} onBlock={block} />}
    </div>
  );
}

/** Whether there is room for the questions beside the page. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia('(min-width: 961px)').matches);
  useEffect(() => {
    const query = matchMedia('(min-width: 961px)'), onChange = () => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/** An in-app dialog. Escape and the area around it close it, and the focus returns to what opened it (Safari doesn't focus a clicked button). */
/** `closer`: a Close button beside the title, which stays at the top. */
function Dialog({ title, class: className, returnTo, onClose, closer, children }: { title: string; class?: string; returnTo: HTMLElement | null; onClose: () => void; closer?: string; children: preact.ComponentChildren }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => { if (returnTo?.isConnected) returnTo.focus(); };
  }, []);
  return (
    <dialog ref={dialog} tabIndex={-1} class={className} aria-label={title} onClose={onClose} onClick={(event) => { if (event.target === dialog.current) dialog.current?.close(); }}>
      {closer ? (
        <>
          <div class="dialog-head"><h2>{title}</h2><button class="plain" onClick={onClose}>{closer}</button></div>
          <div class="dialog-body">{children}</div>
        </>
      ) : <div class="dialog"><h2>{title}</h2>{children}</div>}
    </dialog>
  );
}

function LeaveDialog({ url, returnTo, onClose, onOpened, onBlock }: { url: string; returnTo: HTMLElement | null; onClose: () => void; onOpened: () => void; onBlock: (() => void) | null }) {
  const t = useText();
  return (
    <Dialog title={t('leaveTitle')} returnTo={returnTo} onClose={onClose}>
      <p>{t('leaveHelp')}</p>
      <p class="address" dir="ltr">{url}</p>
      <div class="row">
        <button class="plain" onClick={onClose}>{t('cancel')}</button>
        <a class="primary as-button" href={url} target="_blank" rel="noopener noreferrer" onClick={onOpened}>{t('open')}</a>
      </div>
      {onBlock && <button class="plain wide" onClick={onBlock}>{t('blockPage')}</button>}
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
