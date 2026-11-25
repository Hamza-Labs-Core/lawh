import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { type Answer, call, CallError, type Decision, type Listed, type Me, problemOf } from '../api';
import { Failure, Fill, Heading, Link, useBusy, useSettings, useText } from '../app';
import { day, digits } from '../i18n';

/** What was chosen and written but not recorded yet. In memory only: closing the panel or moving to another screen keeps it. */
const drafts = new Map<string, { option: string | null; notes: string }>();
const NO_DRAFT = { option: null, notes: '' };

/** Tells the bar to count again. */
const changed = () => dispatchEvent(new Event('lawh:decisions'));

const toAnswer = (d: Decision): boolean => d.status === 'open' || d.status === 'stale';
/** How many are for this person to answer now. */
export const left = (items: Decision[], me: Me): number => items.filter((d) => d.mayAnswer && toAnswer(d) && !(d.answersNeeded > 1 && d.agreement.some((a) => a.answeredBy.id === me.id))).length;

function Name({ answer, me }: { answer: Answer; me: Me }) {
  const t = useText();
  return answer.answeredBy.id === me.id ? <>{t('you')}</> : <bdi>{answer.answeredBy.name ?? t('former')}</bdi>;
}

function Given({ answer, me }: { answer: Answer; me: Me }) {
  const { lang } = useSettings();
  return (
    <>
      {answer.optionLabel !== null && <strong><bdi dir="auto">{answer.optionLabel}</bdi></strong>}
      {answer.notes && <p class="lines" dir="auto">{answer.notes}</p>}
      <p class="muted"><Name answer={answer} me={me} />{lang === 'ar' ? '، ' : ', '}{day(lang, answer.answeredAt)}</p>
    </>
  );
}

/** One question: its options, what was answered, and the form for those who may answer. */
export function DecisionCard({ decision, answerers, me, level, onChange }: { decision: Decision; answerers: number | null; me: Me; level: 'h2' | 'h3'; onChange: (next: Decision) => void }) {
  const t = useText(), { lang } = useSettings(), [busy, run] = useBusy(), id = useId(), place = `${me.id} ${decision.id} ${decision.revision}`;
  const [draft, setDraft] = useState(drafts.get(place) ?? NO_DRAFT), [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | 'changedMeanwhile' | 'mayNot' | 'gone' | 'secret' | null>(null);
  const [editing, setEditing] = useState(false), [history, setHistory] = useState<Answer[] | null>(null), [said, setSaid] = useState(false), card = useRef<HTMLDivElement>(null);
  const Title = level, mine = decision.agreement.find((a) => a.answeredBy.id === me.id), needed = decision.answersNeeded, open = toAnswer(decision);
  // Another wording starts over: what was chosen was chosen for the old one. The notes stay, they may be long.
  const lastPlace = useRef(place);
  if (lastPlace.current !== place) {
    const kept = drafts.get(lastPlace.current)?.notes ?? draft.notes;
    drafts.delete(lastPlace.current);
    lastPlace.current = place;
    setDraft({ option: null, notes: kept });
  }
  const write = (change: Partial<typeof draft>) => { const next = { ...draft, ...change }; drafts.set(place, next); setDraft(next); setSaid(false); };
  const take = (next: Decision) => { onChange(next); setHistory(next.history ?? null); changed(); };
  const record = () => run(async () => {
    setProblem(null); setSaid(false);
    try {
      const next = await call<Decision>('POST', `/decisions/${decision.id}/answers`, { revision: decision.revision, seq: decision.answerSeq, optionId: draft.option, notes: draft.notes });
      drafts.delete(place);
      setDraft(NO_DRAFT); setEditing(false); setSaid(true);
      take(next);
      // The form may be gone: the focus stays at this question.
      card.current?.focus();
    } catch (error) {
      const status = error instanceof CallError ? error.status : 0;
      if (status === 409 || status === 403 || status === 404) {
        // Shown as it is now, before answering again.
        await call<Decision>('GET', `/decisions/${decision.id}`).then((next) => { take(next); setProblem(status === 403 ? 'mayNot' : 'changedMeanwhile'); }, (e: unknown) => setProblem(e instanceof CallError && e.status === 404 ? 'gone' : problemOf(e)));
      } else setProblem(error instanceof CallError && error.code === 'secret_found' ? 'secret' : problemOf(error));
    }
  });
  const loadHistory = () => { if (history === null) call<Decision>('GET', `/decisions/${decision.id}`).then((d) => setHistory(d.history ?? []), (error: unknown) => setProblem(problemOf(error))); };
  const most = Math.max(0, ...decision.options.map((o) => decision.agreement.filter((a) => a.optionId === o.id).length));
  const form = decision.mayAnswer && decision.status !== 'withdrawn' && (open || editing);
  const ready = draft.option !== null || (needed === 1 && draft.notes.trim() !== '');
  return (
    <div class="decision" ref={card} tabIndex={-1} data-status={decision.status}>
      <Title id={`${id}-q`}><bdi dir="auto" lang={decision.page.lang}>{decision.question}</bdi></Title>
      {decision.status !== 'open' && <p><span class={`status ${decision.status === 'answered' ? 'decided' : decision.status === 'stale' ? 'in_review' : ''}`}>{t(decision.status === 'answered' ? 'answered' : decision.status === 'stale' ? 'questionChanged' : 'withdrawn')}</span></p>}
      {decision.context && <p class="lines" dir="auto" lang={decision.page.lang}>{decision.context}</p>}
      {open && needed > 1 && (
        <p class="muted"><span class="status in_review"><Fill text="agreeing" n={digits(lang, most)} total={digits(lang, needed)} /></span> <Fill text="mustAgree" n={digits(lang, needed)} />
          {answerers !== null && answerers < needed && <> <Fill text="tooFew" can={digits(lang, answerers)} /></>}</p>
      )}
      {decision.answer && (
        <div class="given"><p class="muted">{t(decision.status === 'answered' ? 'theAnswer' : 'oldAnswer')}</p>
          {decision.status !== 'answered' && <p class="muted"><bdi dir="auto">{decision.answer.question}</bdi></p>}
          <Given answer={decision.answer} me={me} /></div>
      )}
      <form onSubmit={(event) => { event.preventDefault(); if (ready) record(); }}>
        {(open || form) && (
          <fieldset class="opts" disabled={!form || busy} aria-labelledby={`${id}-q`}>
            {decision.options.map((option, i) => {
              const chose = decision.agreement.filter((a) => a.optionId === option.id);
              return (
                <label key={option.id} class={form ? 'opt' : 'opt fixed'}>
                  {form && <input type="radio" name={id} value={option.id} checked={draft.option === option.id} onChange={() => write({ option: option.id })} />}
                  <span>
                    <strong><bdi dir="auto" lang={decision.page.lang}>{option.label}</bdi></strong>{i === 0 && <> <span class="badge">{t('recommended')}</span></>}
                    {option.detail && <span class="lines" dir="auto" lang={decision.page.lang}>{option.detail}</span>}
                    {option.cost && <span class="muted" dir="auto" lang={decision.page.lang}>{option.cost}</span>}
                    {chose.length > 0 && <span class="chose">{t('chosenBy')} {chose.map((a, k) => <span key={a.seq}>{k > 0 && (lang === 'ar' ? '، ' : ', ')}<Name answer={a} me={me} /></span>)}</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        {form && (
          <>
            <textarea class="field notes" rows={3} maxLength={4000} dir="auto" aria-label={t(needed > 1 ? 'notesOptional' : 'notes')} placeholder={t(needed > 1 ? 'notesOptional' : 'notes')} value={draft.notes} disabled={busy} onInput={(event) => write({ notes: event.currentTarget.value })} />
            <button class="primary" type="submit" disabled={!ready || busy}>{t(mine || editing ? 'changeAnswer' : 'record')}</button>
            {editing && <button class="plain wide" type="button" disabled={busy} onClick={() => { setEditing(false); drafts.delete(place); setDraft(NO_DRAFT); card.current?.focus(); }}>{t('cancel')}</button>}
            {decision.answerSeq === 0 && <p class="muted">{t('notRecorded')}</p>}
          </>
        )}
      </form>
      {open && !decision.mayAnswer && <p class="muted">{t('mayNot')}</p>}
      <div aria-live="polite">{said && <p class="done">{t(decision.status === 'answered' ? 'recorded' : 'recordedWaits')}</p>}</div>
      {problem && <Failure>{t(problem)}</Failure>}
      {decision.mayAnswer && decision.status === 'answered' && !editing && <button class="plain wide" onClick={() => { setSaid(false); setEditing(true); }}>{t('changeAnswer')}</button>}
      {decision.answerSeq > 0 && (
        <details onToggle={(event) => { if (event.currentTarget.open) loadHistory(); }}>
          <summary>{t('history')}</summary>
          {history === null && <p class="muted">{t('loading')}</p>}
          <ol class="answers">{history?.map((a) => <li key={a.seq}>{a.revision !== decision.revision && <p class="muted">{t('asked')} <bdi dir="auto">{a.question}</bdi></p>}<Given answer={a} me={me} />{a.needed > 1 && <p class="muted">{t(a.decides ? 'itDecided' : 'itWaited')}</p>}</li>)}</ol>
        </details>
      )}
    </div>
  );
}

/** A page's questions, beside it or in a sheet over it. */
export function DecisionList({ items, answerers, me, onChange }: { items: Decision[]; answerers: number | null; me: Me; onChange: (next: Decision) => void }) {
  return <>{items.map((d) => <DecisionCard key={d.id} decision={d} answerers={answerers} me={me} level="h3" onChange={onChange} />)}</>;
}

const SHOWN = ['open', 'waiting', 'answered'] as const;

/** Every question the person may answer, over all their projects. */
export function Decisions({ search, me }: { search: string; me: Me }) {
  const t = useText(), { lang } = useSettings(), asked = new URLSearchParams(search).get('show'), show = SHOWN.find((s) => s === asked) ?? 'open';
  const [list, setList] = useState<Listed<Decision> | null>(null), [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | null>(null), [tries, setTries] = useState(0), [busy, run] = useBusy(), stopped = useRef(new AbortController());
  useEffect(() => {
    const stop = new AbortController();
    stopped.current = stop;
    setList(null); setProblem(null);
    call<Listed<Decision>>('GET', `/decisions?show=${show}`, undefined, stop.signal).then(setList, (error: unknown) => { if (!stop.signal.aborted) setProblem(problemOf(error)); });
    return () => stop.abort();
  }, [show, tries]);
  const more = () => run(async () => {
    const { signal } = stopped.current;
    setProblem(null);
    try {
      const next = await call<Listed<Decision>>('GET', `/decisions?show=${show}&cursor=${list!.next!}`, undefined, signal);
      // One that was just answered can come again in a list by time.
      if (!signal.aborted) setList((now) => ({ items: [...now!.items, ...next.items.filter((d) => !now!.items.some((o) => o.id === d.id))], next: next.next }));
    } catch (error) { if (!signal.aborted) setProblem(problemOf(error)); }
  });
  const TITLES = { open: 'toAnswer', waiting: 'waiting', answered: 'answered' } as const;
  return (
    <>
      <Heading>{t('decisions')}</Heading>
      <nav class="chips" aria-label={t('decisions')}>{SHOWN.map((s) => <Link key={s} class="chip" to={s === 'open' ? '/decisions' : `/decisions?show=${s}`} current={s === show}>{t(TITLES[s])}</Link>)}</nav>
      <div aria-live="polite">
        {list === null && !problem && <p class="muted">{t('loading')}</p>}
        {list?.items.length === 0 && <div class="card empty"><p>{t(show === 'open' ? 'noOpen' : show === 'waiting' ? 'noWaiting' : 'noAnswered')}</p></div>}
      </div>
      <ul class="grid wide-cards">
        {list?.items.map((d) => (
          <li key={d.id}>
            <div class="card">
              <p class="muted from"><Link to={`/p/${d.project}/${d.page.slug}`}><bdi lang={d.page.lang}>{d.page.title}</bdi></Link>{lang === 'ar' ? '، ' : ', '}<bdi>{d.projectName[lang]}</bdi></p>
              <DecisionCard decision={d} answerers={null} me={me} level="h2" onChange={(next) => setList((now) => now && { ...now, items: now.items.map((o) => (o.id === next.id ? next : o)) })} />
            </div>
          </li>
        ))}
      </ul>
      {problem && <><Failure>{t(problem)}</Failure>{list === null && <button class="plain" onClick={() => setTries(tries + 1)}>{t('retry')}</button>}</>}
      {list?.next && <button class="plain wide" disabled={busy} onClick={more}>{t('more')}</button>}
    </>
  );
}
