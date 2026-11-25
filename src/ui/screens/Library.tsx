import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { call, CallError, type Listed, type PageItem, problemOf, type ProjectName, type Status } from '../api';
import { Failure, Fill, go, Heading, Link, useSettings, useText } from '../app';
import { day, digits } from '../i18n';

const STATUSES: Status[] = ['draft', 'in_review', 'decided', 'archived'];
const KEYS = ['q', 'project', 'status', 'tag'] as const;
type Filters = Record<(typeof KEYS)[number], string>;

const readFilters = (search: string): Filters => { const query = new URLSearchParams(search); return { q: query.get('q') ?? '', project: query.get('project') ?? '', status: query.get('status') ?? '', tag: query.get('tag') ?? '' }; };
const queryOf = (filters: Filters): string => { const query = new URLSearchParams(); for (const key of KEYS) if (filters[key]) query.set(key, filters[key]); return query.toString(); };

export const StatusMark = ({ status }: { status: Status }) => <span class={`status ${status}`}>{useText()(status)}</span>;

/** Pages, newest first, by project, status and tag. The filters are in the address, so Back and a shared link keep them. */
export function Library({ search }: { search: string }) {
  const t = useText(), { lang } = useSettings(), filters = readFilters(search), query = queryOf(filters);
  const [projects, setProjects] = useState<ProjectName[] | null>(null), [projectsProblem, setProjectsProblem] = useState<'offline' | 'wait' | 'failed' | null>(null), [list, setList] = useState<Listed<PageItem> | null>(null), [tries, setTries] = useState(0), [projectTries, setProjectTries] = useState(0);
  const [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | 'filter' | null>(null);
  // Ends with the list it belongs to: "Show more" of an old list must not touch the new one.
  const stopList = useRef(new AbortController()), loadingNow = useRef(false), [loadingMore, setLoadingMore] = useState(false);
  // On their own: the filters are there even when a filter in the address is wrong.
  useEffect(() => {
    if (projects !== null) return;
    const stop = new AbortController();
    setProjectsProblem(null);
    call<Listed<ProjectName>>('GET', '/projects', undefined, stop.signal).then((r) => setProjects(r.items), (error: unknown) => { if (!stop.signal.aborted) setProjectsProblem(problemOf(error)); });
    return () => stop.abort();
  }, [tries, projectTries]);
  useEffect(() => {
    const stop = new AbortController();
    stopList.current = stop;
    setList(null); setProblem(null); setLoadingMore(false); loadingNow.current = false;
    call<Listed<PageItem>>('GET', `/pages${query && `?${query}`}`, undefined, stop.signal).then(setList, (error: unknown) => {
      if (!stop.signal.aborted) setProblem(query && error instanceof CallError && (error.status === 404 || error.status === 422) ? 'filter' : problemOf(error));
    });
    return () => stop.abort();
  }, [query, tries]);
  const set = (change: Partial<Filters>) => { const next = queryOf({ ...filters, ...change }); go(next ? `/?${next}` : '/'); };
  const more = async () => {
    const { signal } = stopList.current;
    // A ref, because a second press can come before the button is drawn as disabled.
    if (loadingNow.current) return;
    loadingNow.current = true;
    setLoadingMore(true); setProblem(null);
    try {
      const next = await call<Listed<PageItem>>('GET', `/pages?${query}&cursor=${list!.next!}`, undefined, signal);
      if (!signal.aborted) setList((now) => ({ items: [...now!.items, ...next.items], next: next.next }));
    } catch (error) { if (!signal.aborted) setProblem(problemOf(error)); }
    if (!signal.aborted) { loadingNow.current = false; setLoadingMore(false); }
  };
  return (
    <>
      <Heading>{t('pages')}</Heading>
      {projects !== null && projects.length > 0 && (
        <div class="filters">
          <SearchBox filters={filters} onSearch={(q) => set({ q })} />
          <Choice label={t('project')} value={filters.project} onChange={(project) => set({ project })} options={[['', t('allProjects')], ...projects.map((p): [string, string] => [p.slug, p.name[lang]])]} />
          <Choice label={t('status')} value={filters.status} onChange={(status) => set({ status })} options={[['', t('anyStatus')], ...STATUSES.map((s): [string, string] => [s, t(s)])]} />
          <TagFilter project={filters.project} value={filters.tag} onChange={(tag) => set({ tag })} />
        </div>
      )}
      <div aria-live="polite">
        {list === null && !problem && <p class="muted">{t('loading')}</p>}
        {problem === 'filter' && <div class="card empty"><p>{t('badFilter')}</p><button class="plain" onClick={() => go('/')}>{t('clear')}</button></div>}
        {list?.items.length === 0 && (query || projects !== null) && (
          <div class="card empty">
            <p>{t(query ? 'noMatches' : projects?.length === 0 ? 'noProjects' : 'noPages')}</p>
            {query && <button class="plain" onClick={() => go('/')}>{t('clear')}</button>}
          </div>
        )}
      </div>
      <ul class="grid">
        {list?.items.map((page) => (
          <li key={page.id}>
            <Link class="card page" to={`/p/${page.project.slug}/${page.slug}`}>
              <StatusMark status={page.status} />
              <h2><bdi lang={page.lang}>{page.title}</bdi></h2>
              {page.summary && <p class="clamp"><bdi lang={page.lang}>{page.summary}</bdi></p>}
              <p class="muted"><bdi>{page.project.name[lang]}</bdi>{lang === 'ar' ? '، ' : ', '}<Fill text="version" n={digits(lang, page.currentVersion)} /></p>
              <p class="muted"><Fill text="updated" date={day(lang, page.updatedAt)} /></p>
              {page.tags.length > 0 && <p class="tags">{page.tags.map((tag) => <bdi key={tag} class="tag">{tag}</bdi>)}</p>}
            </Link>
          </li>
        ))}
      </ul>
      {projectsProblem && !problem && <><Failure>{t(projectsProblem)}</Failure><button class="plain" onClick={() => setProjectTries(projectTries + 1)}>{t('retry')}</button></>}
      {problem && problem !== 'filter' && <><Failure>{t(problem)}</Failure>{list === null && <button class="plain" onClick={() => setTries(tries + 1)}>{t('retry')}</button>}</>}
      {list?.next && <button class="plain wide" disabled={loadingMore} onClick={() => void more()}>{t('more')}</button>}
    </>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div class="choice">
      <label class="muted" for={id}>{label}</label>
      <select id={id} class="field" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map(([key, text]) => <option key={key} value={key} selected={key === value}>{text}</option>)}
      </select>
    </div>
  );
}

/** Pages that match, live while typing. One is opened, or Enter shows all in the list. */
function SearchBox({ filters, onSearch }: { filters: Filters; onSearch: (q: string) => void }) {
  const t = useText(), { lang } = useSettings(), id = useId(), [text, setText] = useState(filters.q), [items, setItems] = useState<PageItem[] | null>(null), [open, setOpen] = useState(false), [at, setAt] = useState(-1);
  const box = useRef<HTMLFormElement>(null), { project, status, tag } = filters, now = text.trim();
  // Back and "Clear filters" change the address, and the field follows it.
  useEffect(() => { setText(filters.q); setItems(null); setAt(-1); }, [filters.q]);
  useEffect(() => { if (at >= 0) document.getElementById(`${id}-${at}`)?.scrollIntoView({ block: 'nearest' }); }, [at]);
  useEffect(() => {
    setItems(null); setAt(-1);
    if (!open || now === '') return;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      call<Listed<PageItem>>('GET', `/pages?${queryOf({ q: now, project, status, tag })}&limit=8`, undefined, stop.signal).then((r) => setItems(r.items), () => undefined);
    }, 150);
    return () => { clearTimeout(timer); stop.abort(); };
  }, [now, project, status, tag, open]);
  const show = open && now !== '' && items !== null;
  const search = () => { setOpen(false); if (now !== filters.q) onSearch(now); };
  return (
    <form class="choice search" role="search" ref={box} onSubmit={(event) => { event.preventDefault(); const page = show ? items[at] : undefined; if (page) go(`/p/${page.project.slug}/${page.slug}`); else search(); }}
      onFocusOut={(event) => { if (!box.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <label class="muted" for={id}>{t('search')}</label>
      <input id={id} class="field" enterkeyhint="search" role="combobox" aria-expanded={show} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={show && at >= 0 ? `${id}-${at}` : undefined}
        autocomplete="off" maxLength={100} dir="auto" placeholder={t('searchHint')} value={text}
        onInput={(event) => { const next = event.currentTarget.value; setText(next); setOpen(true); if (next === '' && filters.q !== '') onSearch(''); }}
        onKeyDown={(event) => {
          const n = show ? items.length : 0;
          if (event.key === 'Escape' && show) { event.preventDefault(); setOpen(false); }
          else if (n > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setAt((at + (event.key === 'ArrowDown' ? 1 : n + (at < 0 ? 0 : -1))) % n); }
        }} />
      <ul id={`${id}-list`} class="options" role="listbox" aria-label={t('search')} hidden={!show}>
        {items?.map((page, i) => (
          <li key={page.id} id={`${id}-${i}`} role="option" aria-selected={i === at} onMouseDown={(event) => event.preventDefault()} onClick={() => go(`/p/${page.project.slug}/${page.slug}`)}>
            <bdi lang={page.lang}>{page.title}</bdi><span class="muted"><bdi>{page.project.name[lang]}</bdi></span>
          </li>
        ))}
        {items?.length === 0 && <li class="muted" role="option" aria-disabled="true" aria-selected="false">{t('noMatches')}</li>}
      </ul>
    </form>
  );
}

/** A live list of the tags in use, narrowed while typing. */
function TagFilter({ project, value, onChange }: { project: string; value: string; onChange: (value: string) => void }) {
  const t = useText(), id = useId(), [text, setText] = useState(''), [found, setItems] = useState<string[] | null>(null), [open, setOpen] = useState(false), [at, setAt] = useState(-1);
  // What was found for an earlier text is narrowed at once, before the answer for this one.
  const now = text.trim().normalize('NFC'), narrowed = found?.filter((tag) => tag.startsWith(now)) ?? [];
  // Nothing left of an earlier answer isn't "no tags": the answer is still to come.
  const items = found === null || (narrowed.length === 0 && found.length > 0) ? null : narrowed;
  const box = useRef<HTMLDivElement>(null), refocus = useRef(false);
  // Another project has other tags.
  const forget = () => { setItems(null); setAt(-1); };
  useEffect(forget, [project]);
  // Choosing and clearing swap the field for a button and back; the focus goes along.
  useEffect(() => {
    if (refocus.current) box.current?.querySelector<HTMLElement>('.field')?.focus();
    refocus.current = false;
  }, [value]);
  useEffect(() => { if (at >= 0) document.getElementById(`${id}-${at}`)?.scrollIntoView({ block: 'nearest' }); }, [at]);
  useEffect(() => {
    if (!open) return;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ q: text, ...(project && { project }) });
      call<{ items: string[] }>('GET', `/tags?${query}`, undefined, stop.signal).then((r) => { setItems(r.items); setAt(-1); }, () => undefined);
    }, 120);
    return () => { clearTimeout(timer); stop.abort(); };
  }, [text, project, open]);
  const choose = (tag: string) => { setOpen(false); setText(''); forget(); refocus.current = true; onChange(tag); };
  if (value) {
    return (
      <div class="choice" ref={box}>
        <span class="muted">{t('tag')}</span>
        <button class="field chosen" aria-label={`${t('clearTag')}: ${value}`} onClick={() => { refocus.current = true; onChange(''); }}><bdi>{value}</bdi><span aria-hidden="true">×</span></button>
      </div>
    );
  }
  return (
    <div class="choice" ref={box} onFocusOut={(event) => { if (!box.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <label class="muted" for={id}>{t('tag')}</label>
      <input id={id} class="field" role="combobox" aria-expanded={open && items !== null} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && items !== null && at >= 0 ? `${id}-${at}` : undefined}
        autocomplete="off" placeholder={t('tagHint')} value={text} onFocus={() => { if (!refocus.current) setOpen(true); }} onClick={() => setOpen(true)}
        onInput={(event) => { setText(event.currentTarget.value); setAt(-1); setOpen(true); if (found?.length === 0) setItems(null); }}
        onKeyDown={(event) => {
          const n = items?.length ?? 0;
          if (event.key === 'Escape') setOpen(false);
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); if (n > 0) setAt((at + (event.key === 'ArrowDown' ? 1 : n + (at < 0 ? 0 : -1))) % n); }
          else if (event.key === 'Enter' && open) { event.preventDefault(); const tag = items?.[at] ?? items?.find((i) => i === now); if (tag) choose(tag); }
        }} />
      <ul id={`${id}-list`} class="options" role="listbox" aria-label={t('tag')} hidden={!open || items === null}>
        {items?.map((tag, i) => <li key={tag} id={`${id}-${i}`} role="option" aria-selected={i === at} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(tag)}><bdi>{tag}</bdi></li>)}
        {items?.length === 0 && <li class="muted" role="option" aria-disabled="true" aria-selected="false">{t('noTags')}</li>}
      </ul>
    </div>
  );
}
