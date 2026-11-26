import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { newId } from '../../shared/ids';
import { call, CallError, type Comment, type Listed, type Me, problemOf, type Thread } from '../api';
import { Failure, Fill, Heading, Link, useBusy, useSettings, useText } from '../app';
import type { Section } from '../bridgeHost';
import { digits, moment } from '../i18n';

/** What was written but not sent. In memory only, cleared on sign-out. With its id: sent again after a lost reply, it is written once. */
const drafts = new Map<string, { text: string; id: string }>();
const sections = new Map<string, string>();
const deletedReplies = new Set<string>();
addEventListener('lawh:signed-out', () => { drafts.clear(); sections.clear(); deletedReplies.clear(); });

type Problem = 'offline' | 'wait' | 'failed' | 'commentGone' | 'commentNot' | 'secretComment';
const problemIn = (error: unknown): Problem =>
  !(error instanceof CallError) ? 'failed' : error.status === 403 ? 'commentNot' : error.status === 404 || error.status === 409 ? 'commentGone' : error.code === 'secret_found' ? 'secretComment' : problemOf(error);

/** A field and its button. What is written stays until it is sent. */
function Write({ place, label, action, send, children, beside }: { place: string; label: string; action: string; send: (id: string, body: string) => Promise<void>; children?: preact.ComponentChildren; beside?: preact.ComponentChildren }) {
  const t = useText(), [draft, setDraft] = useState(() => drafts.get(place) ?? { text: '', id: '' }), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null), field = useRef<HTMLTextAreaElement>(null);
  const write = (text: string) => { const next = { text, id: newId('cmt') }; drafts.set(place, next); setDraft(next); };
  const submit = () => {
    // Before the button disables, so focus stays inside the sheet while sending.
    field.current?.focus();
    const id = drafts.get(place)?.id || draft.id;
    return run(async () => {
      setProblem(null);
      try {
        await send(id, draft.text);
        drafts.delete(place);
        setDraft({ text: '', id: '' });
      } catch (error) { setProblem(problemIn(error)); }
      field.current?.focus();
    });
  };
  return (
    <form class="write" onSubmit={(event) => { event.preventDefault(); if (draft.text.trim() !== '') submit(); }}>
      {children}
      <textarea ref={field} class="field notes" rows={2} maxLength={10_000} dir="auto" aria-label={label} placeholder={label} value={draft.text} readOnly={busy} onInput={(event) => write(event.currentTarget.value)} />
      {problem && <Failure>{t(problem)}</Failure>}
      <div class="row"><button class="primary" type="submit" disabled={busy || draft.text.trim() === ''}>{action}</button>{beside}</div>
    </form>
  );
}

function One({ comment, me, onDelete }: { comment: Comment; me: Me; onDelete: () => Promise<void> }) {
  const t = useText(), { lang } = useSettings(), [asking, setAsking] = useState(false), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null), box = useRef<HTMLDivElement>(null);
  const own = comment.person?.id === me.id;
  return (
    <div class="one" ref={box} tabIndex={-1}>
      <p class="who"><strong>{own ? t('you') : <bdi>{comment.authorType === 'agent' ? comment.agent : comment.person?.name ?? t('former')}</bdi>}</strong>
        {comment.authorType === 'agent' ? <span class="status">{t('agent')}</span> : comment.fromDecider && !own && <span class="status decided">{t('level3')}</span>} <span class="muted">{moment(lang, comment.createdAt)}</span></p>
      <p class="lines" dir="auto">{comment.body}</p>
      {problem && <Failure>{t(problem)}</Failure>}
      {comment.mayDelete && (asking
        ? <div class="row"><button class="plain" disabled={busy} onClick={() => { box.current?.focus(); void run(async () => { setProblem(null); try { await onDelete(); } catch (error) { setProblem(problemIn(error)); } }); }}>{t(comment.id === comment.threadId ? 'deleteThread' : 'deleteIt')}</button><button class="plain" disabled={busy} onClick={() => { setAsking(false); box.current?.focus(); }}>{t('cancel')}</button></div>
        : <button class="text muted" onClick={() => { setAsking(true); box.current?.focus(); }}>{t('delete')}</button>)}
    </div>
  );
}

export interface ThreadChange { change: (id: string, update: (now: Thread) => Thread) => void; remove: (id: string) => void }

export function ThreadCard({ thread, me, change, remove, title }: { thread: Thread; me: Me; title?: preact.ComponentChildren } & ThreadChange) {
  const t = useText(), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null), box = useRef<HTMLElement>(null);
  const act = (what: () => Promise<void>) => {
    box.current?.focus();
    return run(async () => { setProblem(null); try { await what(); } catch (error) { setProblem(problemIn(error)); } });
  };
  const earlier = () => {
    const cursor = thread.moreReplies!;
    return act(async () => {
      const next = await call<Listed<Comment>>('GET', `/comments/${thread.id}/replies?cursor=${cursor}`);
      change(thread.id, (now) => {
        const have = new Set(now.replies.map((c) => c.id));
        return { ...now, replies: [...next.items.filter((c) => !have.has(c.id) && !deletedReplies.has(c.id)), ...now.replies], moreReplies: next.next };
      });
    });
  };
  // The server's newest 50, and what was already shown before them (ordered by createdAt, id), excluding replies deleted meanwhile.
  const take = (next: Thread) => change(thread.id, (now) => {
    const fresh = next.replies.filter((c) => !deletedReplies.has(c.id)), first = fresh[0], have = new Set(fresh.map((c) => c.id));
    const older = next.moreReplies === null || !first ? [] : now.replies.filter((c) => !have.has(c.id) && !deletedReplies.has(c.id) && (c.createdAt < first.createdAt || (c.createdAt === first.createdAt && c.id < first.id)));
    return { ...next, replies: [...older, ...fresh], moreReplies: older.length > 0 ? now.moreReplies : next.moreReplies };
  });
  const resolve = thread.mayResolve && <button class="plain" type="button" disabled={busy} onClick={() => act(async () => { take(await call<Thread>('PUT', `/comments/${thread.id}/resolved`, { resolved: thread.resolvedAt === null })); box.current?.focus(); })}>{t(thread.resolvedAt === null ? 'resolve' : 'reopen')}</button>;
  return (
    <article class="thread" ref={box} tabIndex={-1} data-resolved={thread.resolvedAt !== null}>
      {title}
      {thread.quote && <blockquote dir="auto">{thread.quote}</blockquote>}
      <One comment={thread} me={me} onDelete={async () => { await call('DELETE', `/comments/${thread.id}`); remove(thread.id); }} />
      {thread.moreReplies && <button class="plain wide" disabled={busy} onClick={earlier}>{t('earlierReplies')}</button>}
      <div class="replies">
        {thread.replies.map((c) => <One key={c.id} comment={c} me={me} onDelete={async () => { await call('DELETE', `/comments/${c.id}`); deletedReplies.add(c.id); change(thread.id, (now) => ({ ...now, replies: now.replies.filter((o) => o.id !== c.id) })); box.current?.focus(); }} />)}
      </div>
      {thread.mayReply ? <Write beside={resolve} place={`${me.id} ${thread.id}`} label={t('reply')} action={t('reply')} send={async (id, body) => take(await call<Thread>('POST', `/comments/${thread.id}/replies`, { id, body }))} /> : resolve}
      {problem && <Failure>{t(problem)}</Failure>}
    </article>
  );
}

export interface Threads extends Listed<Thread> { mayComment: boolean }

/** A page's threads, by section, and a form for a new one. `outline` is null until the page has told its sections. */
export function CommentList({ threads, outline, versionN, path, me, onAdd, onMore, onGoTo, change, remove }: {
  threads: Threads; outline: Section[] | null; versionN: number; path: string; me: Me; onAdd: (next: Thread) => void; onMore: () => Promise<void>; onGoTo: (id: string) => void;
} & ThreadChange) {
  const t = useText(), { lang } = useSettings(), id = useId(), place = `${me.id} ${path}`, [section, setSection] = useState(() => sections.get(place) ?? ''), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null);
  const pickSection = (next: string) => {
    setSection(next);
    if (next) sections.set(place, next); else sections.delete(place);
    const cur = drafts.get(place);
    if (cur) drafts.set(place, { ...cur, id: newId('cmt') });
  };
  const chosen = outline?.find((s) => s.id === section) ?? null;
  const open = threads.items.filter((c) => c.resolvedAt === null), resolved = threads.items.filter((c) => c.resolvedAt !== null);
  const there = new Set(outline?.map((s) => s.id) ?? []);
  // Sections by the page's own order; what the page no longer has comes last, under the title it had.
  const groups: [string, string | null, Thread[]][] = [
    ['', null, open.filter((c) => c.sectionId === null)],
    ...(outline ?? []).map((s): [string, string, Thread[]] => [s.id, s.title, open.filter((c) => c.sectionId === s.id)]),
  ];
  const gone = open.filter((c) => c.sectionId !== null && !there.has(c.sectionId));
  // The threads wait for the sections, so they don't jump to their places later; not for long, if the page doesn't tell.
  const [waited, setWaited] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setWaited(true), 2000); return () => clearTimeout(timer); }, []);
  const placed = outline !== null || waited;
  const show = (c: Thread, title?: preact.ComponentChildren) => <ThreadCard key={c.id} thread={c} me={me} change={change} remove={remove} title={title} />;
  const named = (c: Thread) => (c.sectionTitle === null ? undefined : <p class="muted"><bdi dir="auto">{c.sectionTitle}</bdi></p>);
  return (
    <>
      {threads.mayComment ? (
        <Write place={place} label={t('newComment')} action={t('addComment')} send={async (cid, body) => { const created = await call<Thread>('POST', `${path}/comments`, { id: cid, body, versionN, section: chosen && { id: chosen.id, title: chosen.title, quote: chosen.quote } }); sections.delete(place); onAdd(created); }}>
          {/* There before the page has told its sections, so nothing moves under a finger. */}
          <div class="choice"><label class="muted" for={id}>{t('section')}</label>
              <select id={id} class="field" value={chosen?.id ?? ''} onChange={(event) => pickSection(event.currentTarget.value)}>
                <option value="" selected={chosen === null}>{t('wholePage')}</option>
                {outline?.map((s) => <option key={s.id} value={s.id} selected={s.id === chosen?.id}>{'  '.repeat(s.level - 1) + s.title}</option>)}
              </select></div>
        </Write>
      ) : <p class="muted">{t('commentNot')}</p>}
      {threads.items.length === 0 && <p class="muted">{t('noComments')}</p>}
      {!placed && threads.items.length > 0 && <p class="muted">{t('loading')}</p>}
      {placed && groups.filter(([, , list]) => list.length > 0).map(([key, title, list]) => (
        <section key={key} class="threads">
          {title !== null && <h3><button class="text" onClick={() => onGoTo(key)}><bdi dir="auto">{title}</bdi></button></h3>}
          {list.map((c) => show(c))}
        </section>
      ))}
      {placed && gone.length > 0 && <section class="threads">{outline !== null && <h3>{t('earlierSections')}</h3>}{gone.map((c) => show(c, named(c)))}</section>}
      {placed && resolved.length > 0 && <details><summary><Fill text="resolvedN" n={digits(lang, resolved.length)} /></summary><div class="threads">{resolved.map((c) => show(c, named(c)))}</div></details>}
      {problem && <Failure>{t(problem)}</Failure>}
      {threads.next && <button class="plain wide" disabled={busy} onClick={() => run(async () => { setProblem(null); try { await onMore(); } catch (error) { setProblem(problemIn(error)); } })}>{t('more')}</button>}
    </>
  );
}

/** Open threads over every project the person sees. */
export function Comments({ me }: { me: Me }) {
  const t = useText(), { lang } = useSettings();
  const [list, setList] = useState<Listed<Thread> | null>(null), [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | null>(null), [tries, setTries] = useState(0), [busy, run] = useBusy();
  useEffect(() => {
    const stop = new AbortController();
    setProblem(null);
    call<Listed<Thread>>('GET', '/comments', undefined, stop.signal).then(setList, (error: unknown) => { if (!stop.signal.aborted) setProblem(problemOf(error)); });
    return () => stop.abort();
  }, [tries]);
  const more = () => run(async () => {
    setProblem(null);
    try { const next = await call<Listed<Thread>>('GET', `/comments?cursor=${list!.next!}`); setList((now) => ({ items: [...now!.items, ...next.items], next: next.next })); } catch (error) { setProblem(problemOf(error)); }
  });
  const change = (id: string, update: (now: Thread) => Thread) => setList((now) => now && { ...now, items: now.items.map((c) => (c.id === id ? { ...c, ...update(c) } : c)) });
  const remove = (id: string) => setList((now) => now && { ...now, items: now.items.filter((c) => c.id !== id) });
  return (
    <>
      <Heading>{t('comments')}</Heading>
      <div aria-live="polite">
        {list === null && !problem && <p class="muted">{t('loading')}</p>}
        {list?.items.length === 0 && <div class="card empty"><p>{t('noOpenThreads')}</p></div>}
      </div>
      <ul class="grid wide-cards">
        {list?.items.map((c) => (
          <li key={c.id}><div class="card"><ThreadCard thread={c} me={me} change={change} remove={remove} title={c.page && c.projectName && (
            <p class="muted from"><Link to={`/p/${c.project!}/${c.page.slug}`}><bdi lang={c.page.lang}>{c.page.title}</bdi></Link>{lang === 'ar' ? '، ' : ', '}<bdi>{c.projectName[lang]}</bdi>{c.sectionTitle !== null && <><br /><Fill text="inSection" title={c.sectionTitle} /></>}</p>
          )} /></div></li>
        ))}
      </ul>
      {problem && <><Failure>{t(problem)}</Failure>{list === null && <button class="plain" onClick={() => setTries(tries + 1)}>{t('retry')}</button>}</>}
      {list?.next && <button class="plain wide" disabled={busy} onClick={more}>{t('more')}</button>}
    </>
  );
}
