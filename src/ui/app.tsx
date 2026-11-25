import { type ComponentChildren, createContext } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { type Key, type Lang, translate } from './i18n';

interface Settings { lang: Lang; mode: 'dark' | 'light'; setLang: (lang: Lang) => void; setMode: (mode: 'dark' | 'light') => void }
const SettingsContext = createContext<Settings>(null as unknown as Settings);
export const useSettings = () => useContext(SettingsContext);
export function useText(): (key: Key, values?: Record<string, string>) => string {
  const { lang } = useSettings();
  return useCallback((key: Key, values?: Record<string, string>) => translate(lang, key, values), [lang]);
}

const keep = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private window */ } };

export function SettingsProvider({ children }: { children: ComponentChildren }) {
  const root = document.documentElement;
  const [lang, setLang] = useState<Lang>(root.lang === 'ar' ? 'ar' : 'en');
  const [mode, setMode] = useState<'dark' | 'light'>(root.dataset.mode === 'light' ? 'light' : 'dark');
  useEffect(() => { root.lang = lang; root.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.title = translate(lang, 'app'); }, [lang]);
  useEffect(() => { root.dataset.mode = mode; }, [mode]);
  return (
    <SettingsContext.Provider value={{ lang, mode, setLang: (l) => { keep('lawh-lang', l); setLang(l); }, setMode: (m) => { keep('lawh-mode', m); setMode(m); } }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function TopBar({ children }: { children?: ComponentChildren }) {
  const t = useText(), { lang, mode, setLang, setMode } = useSettings();
  return (
    <header class="top">
      <span class="logo">{t('app')}</span>
      <span class="space" />
      {children}
      <button class="plain" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>{t(mode === 'dark' ? 'light' : 'dark')}</button>
      <button class="plain" lang={lang === 'ar' ? 'en' : 'ar'} onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{t('otherLang')}</button>
    </header>
  );
}

export const Failure = ({ children }: { children: ComponentChildren }) => <p class="failure" role="alert">{children}</p>;

/** Runs something that takes a while: the button that starts it is disabled meanwhile. */
export function useBusy(): [boolean, (run: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false);
  return [busy, (run) => { if (busy) return; setBusy(true); void run().finally(() => setBusy(false)); }];
}

export function go(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
