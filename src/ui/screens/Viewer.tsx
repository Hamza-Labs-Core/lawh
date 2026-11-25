import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Fill, useSettings, useText } from '../app';
import { type Media, readViewerMessage, viewerKey, type ViewerMessage } from '../bridgeHost';
import { digits } from '../i18n';

/**
 * A picture of a page, full size. The frame in the middle is the content host's own viewer, sandboxed like the page;
 * the bar around it is the app's.
 */
export function Viewer({ media, frameUrl, onMove, onClose }: { media: Media; frameUrl: string; onMove: (index: number) => void; onClose: () => void }) {
  const t = useText(), { lang } = useSettings(), rtl = lang === 'ar';
  const dialog = useRef<HTMLDialogElement>(null), frame = useRef<HTMLIFrameElement>(null), ready = useRef(false), [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading');
  const post = (message: object, transfer: Transferable[] = []) => frame.current?.contentWindow?.postMessage(message, '*', transfer);
  const show = () => {
    if (!ready.current) return;
    const { picture, label, background } = media;
    if (picture.kind === 'none') { setState('failed'); return; }
    setState('loading');
    post({ type: 'lawh:view', label, background, ...picture });
  };
  // Read by listeners that stay for the dialog's whole life.
  const now = useRef({ show, act: (_: ViewerMessage) => {} });
  now.current = { show, act: (what) => {
    if (what === 'ready') { ready.current = true; now.current.show(); }
    else if (what === 'shown' || what === 'failed') setState(what);
    else if (what === 'close') onClose();
    else if (what === 'next') { if (media.index < media.total - 1) onMove(media.index + 1); }
    else if (what === 'previous') { if (media.index > 0) onMove(media.index - 1); }
    else if (what === 'fit') post({ type: 'lawh:fit' });
    else post({ type: 'lawh:zoom', by: what === 'in' ? 1.4 : 1 / 1.4 });
  } };
  useEffect(() => { show(); }, [media]);
  // Before the frame can speak: from the cache it is quicker than an effect after the paint.
  useLayoutEffect(() => {
    dialog.current?.showModal();
    const onMessage = (event: MessageEvent) => {
      const message = readViewerMessage(event, frame.current?.contentWindow, document.documentElement.dir === 'rtl');
      if (message) now.current.act(message);
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key === 'Escape') return;
    const what = viewerKey(event.key, rtl);
    if (what) { event.preventDefault(); now.current.act(what); }
  };
  const act = (what: ViewerMessage) => now.current.act(what);
  return (
    <dialog ref={dialog} class="viewer" data-state={state} aria-label={media.label || t('picture')} onClose={onClose} onKeyDown={onKey}>
      <div class="viewer-bar">
        <p class="viewer-label"><bdi>{media.label || t('picture')}</bdi></p>
        <button class="plain viewer-close" onClick={onClose}>{t('close')}</button>
        <p class="muted" aria-live="polite"><Fill text="nOf" n={digits(lang, media.index + 1)} total={digits(lang, media.total)} /></p>
        <button class="plain" aria-label={t('zoomOut')} onClick={() => act('out')}>−</button>
        <button class="plain" onClick={() => act('fit')}>{t('fit')}</button>
        <button class="plain" aria-label={t('zoomIn')} onClick={() => act('in')}>+</button>
      </div>
      <div class="viewer-middle">{/* Right-to-left text mirrors ‹ and › by itself. */}
        <iframe ref={frame} class="viewer-frame" title={t('viewerFrame')} sandbox="allow-scripts" referrerpolicy="no-referrer" src={frameUrl} onLoad={() => act('ready')} />
        {state === 'loading' && <p class="viewer-note" role="status">{t('loading')}</p>}
        {state === 'failed' && <p class="viewer-note" role="status">{t('noPicture')}</p>}
        <button class="plain viewer-side previous" aria-label={t('previous')} disabled={media.index === 0} onClick={() => act('previous')}><span aria-hidden="true">‹</span></button>
        <button class="plain viewer-side next" aria-label={t('nextPicture')} disabled={media.index >= media.total - 1} onClick={() => act('next')}><span aria-hidden="true">›</span></button>
      </div>
      <p class="viewer-help muted">{t('viewerHelp')}</p>
    </dialog>
  );
}
