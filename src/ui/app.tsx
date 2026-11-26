import { type ComponentChildren, createContext } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { type Key, type Lang, parts, translate } from './i18n';

interface Settings { lang: Lang; mode: 'dark' | 'light'; setLang: (lang: Lang) => void; setMode: (mode: 'dark' | 'light') => void }
const SettingsContext = createContext<Settings>(null as unknown as Settings);
export const useSettings = () => useContext(SettingsContext);
export function useText(): (key: Key) => string {
  const { lang } = useSettings();
  return useCallback((key: Key) => translate(lang, key), [lang]);
}

/** A text with its places filled. Each is isolated, so a name or an address in the other direction doesn't disturb the text around it. */
export function Fill({ text, dir, ...values }: { text: Key; dir?: 'ltr'; [value: string]: string | undefined }) {
  const { lang } = useSettings();
  return <>{parts(lang, text, values as Record<string, string>).map((part, i) => (typeof part === 'string' ? part : part.value ? <bdi key={i} dir={dir}>{part.value}</bdi> : null))}</>;
}

const keep = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private window */ } };

export const brandName = (lang: Lang): string => {
  const { brandEn, brandAr } = document.documentElement.dataset;
  return (lang === 'ar' ? brandAr : brandEn) || translate(lang, 'app');
};

export function SettingsProvider({ children }: { children: ComponentChildren }) {
  const root = document.documentElement;
  const [lang, setLang] = useState<Lang>(root.lang === 'ar' ? 'ar' : 'en');
  const [mode, setMode] = useState<'dark' | 'light'>(root.dataset.mode === 'light' ? 'light' : 'dark');
  useEffect(() => { root.lang = lang; root.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.title = brandName(lang); }, [lang]);
  useEffect(() => {
    root.dataset.mode = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'light' ? '#f6f4ef' : '#12161a');
  }, [mode]);
  return (
    <SettingsContext.Provider value={{ lang, mode, setLang: (l) => { keep('lawh-lang', l); setLang(l); }, setMode: (m) => { keep('lawh-mode', m); setMode(m); } }}>
      {children}
    </SettingsContext.Provider>
  );
}

/** A link inside the app: a real address, opened without loading the app again. `onGo` is done instead of opening it. */
export function Link({ to, class: className, children, current, onGo }: { to: string; class?: string; children: ComponentChildren; current?: boolean; onGo?: (() => void) | undefined }) {
  return <a href={to} class={className} aria-current={current ? 'page' : undefined} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (onGo) onGo(); else go(to);
  }}>{children}</a>;
}

export function TopBar({ children }: { children?: ComponentChildren }) {
  const t = useText(), { lang, mode, setLang, setMode } = useSettings();
  return (
    <header class="top">
      <Link class="logo" to="/">{brandName(lang)}</Link>
      {children}
      <span class="space" />
      <button class="plain" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>{t(mode === 'dark' ? 'light' : 'dark')}</button>
      <button class="plain" lang={lang === 'ar' ? 'en' : 'ar'} onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{t('otherLang')}</button>
    </header>
  );
}

export const Failure = ({ children }: { children: ComponentChildren }) => <p class="failure" role="alert">{children}</p>;

/** Runs something that takes a while: the button that starts it is disabled meanwhile, and a second start is ignored. */
export function useBusy(): [boolean, (run: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false), running = useRef(false);
  return [busy, (run) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    void run().finally(() => { running.current = false; setBusy(false); });
  }];
}

let firstScreen = true;
/** A screen's heading. It takes the focus when the screen changes, so a keyboard or a screen reader goes on from there. */
export function Heading({ children, class: className }: { children: ComponentChildren; class?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!firstScreen) heading.current?.focus();
    firstScreen = false;
  }, []);
  return <h1 ref={heading} tabIndex={-1} class={className}>{children}</h1>;
}

/** Whether the page before this one is the app's own. */
export const wasInside = (): boolean => (history.state as { inside?: boolean } | null)?.inside === true;

/** `replace`: Back doesn't return to a page whose work is done. */
export function go(path: string, replace = false): void {
  const state = { inside: replace ? wasInside() : true };
  if (replace) history.replaceState(state, '', path); else history.pushState(state, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
