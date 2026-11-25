import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Fill, useSettings, useText } from '../app';
import { type Act, discard, type Media, readViewerMessage, viewerKey } from '../bridgeHost';
import { digits } from '../i18n';

/**
 * A picture of a page, full size. The frame in the middle is the content host's own viewer, sandboxed like the page;
 * the bar around it is the app's.
 */
export function Viewer({ media, frameUrl, onMove, onClose, onBlock }: { media: Media; frameUrl: string; onMove: (index: number) => void; onClose: () => void; onBlock: (() => void) | null }) {
  const t = useText(), { lang } = useSettings(), rtl = lang === 'ar';
  const dialog = useRef<HTMLDialogElement>(null), frame = useRef<HTMLIFrameElement>(null), ready = useRef(false), asked = useRef(0), [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading');
  // A bitmap is handed over once; until then it is this screen's to free.
  const pending = useRef<Media | null>(null), target = useRef(media.index);
  const post = (message: object, transfer: Transferable[] = []) => frame.current?.contentWindow?.postMessage(message, '*', transfer);
  const show = () => {
    const now = pending.current;
    if (!ready.current || !now) return;
    pending.current = null;
    const { picture, label, background } = now, id = ++asked.current;
    setState(picture.kind === 'none' ? 'failed' : 'loading');
    try { post({ type: 'lawh:view', id, label: label || t('picture'), background, ...picture }, picture.kind === 'bitmap' ? [picture.bitmap] : []); }
    catch { discard(picture); setState('failed'); }
  };
  const act = (what: Act) => {
    if (what === 'close') onClose();
    else if (what === 'next' || what === 'previous') {
      // Counted from the one already asked for, so quick presses add up.
      const to = target.current + (what === 'next' ? 1 : -1);
      if (to >= 0 && to < media.total) { target.current = to; onMove(to); }
    }
    else if (what === 'fit') post({ type: 'lawh:fit' });
    else post({ type: 'lawh:zoom', by: what === 'in' ? 1.4 : 1 / 1.4 });
  };
  // Read by listeners that stay for the dialog's whole life.
  const now = useRef({ show, act });
  now.current = { show, act };
  const isReady = () => { if (!ready.current) { ready.current = true; now.current.show(); } };
  useEffect(() => {
    if (pending.current) discard(pending.current.picture);
    pending.current = media;
    show();
  }, [media]);
  // Before the frame can speak: from the cache it is quicker than an effect after the paint.
  useLayoutEffect(() => {
    dialog.current?.showModal();
    const onMessage = (event: MessageEvent) => {
      const message = readViewerMessage(event, frame.current?.contentWindow, document.documentElement.dir === 'rtl');
      if (message === null) return;
      if (message === 'ready') isReady();
      else if (typeof message === 'string') now.current.act(message);
      else if (message.id === asked.current) setState(message.done);
    };
    addEventListener('message', onMessage);
    return () => { removeEventListener('message', onMessage); if (pending.current) discard(pending.current.picture); };
  }, []);
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key === 'Escape') return;
    const what = viewerKey(event.key, rtl);
    if (what) { event.preventDefault(); act(what); }
  };
  return (
    <dialog ref={dialog} class="viewer" data-state={state} aria-label={media.label || t('picture')} onClose={onClose} onKeyDown={onKey}>
      <div class="viewer-bar">
        <p class="viewer-label"><bdi>{media.label || t('picture')}</bdi></p>
        <button class="plain viewer-close" onClick={onClose}>{t('close')}</button>
        <p class="muted" aria-live="polite"><Fill text="nOf" n={digits(lang, media.index + 1)} total={digits(lang, media.total)} /></p>
        <button class="plain" aria-label={t('zoomOut')} onClick={() => act('out')}>−</button>
        <button class="plain" onClick={() => act('fit')}>{t('fit')}</button>
        <button class="plain" aria-label={t('zoomIn')} onClick={() => act('in')}>+</button>
        {onBlock && <button class="plain viewer-block" onClick={onBlock}>{t('blockPage')}</button>}
      </div>
      {/* Right-to-left text mirrors ‹ and › by itself. */}
      <div class="viewer-middle">
        <iframe ref={frame} class="viewer-frame" title={t('viewerFrame')} sandbox="allow-scripts" referrerpolicy="no-referrer" src={frameUrl} onLoad={isReady} />
        {state === 'loading' && <p class="viewer-note" role="status">{t('loading')}</p>}
        {state === 'failed' && <p class="viewer-note" role="status">{t('noPicture')}</p>}
        <button class="plain viewer-side previous" aria-label={t('previous')} disabled={media.index === 0} onClick={() => act('previous')}><span aria-hidden="true">‹</span></button>
        <button class="plain viewer-side next" aria-label={t('nextPicture')} disabled={media.index >= media.total - 1} onClick={() => act('next')}><span aria-hidden="true">›</span></button>
      </div>
      <p class="viewer-help muted">{t('viewerHelp')}</p>
    </dialog>
  );
}
