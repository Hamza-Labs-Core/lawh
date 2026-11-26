import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { type Agent, call, CallError, type DeletedPage, type FailedDelivery, type Listed, type Me, problemOf, type ProjectName, type WebhookItem } from '../api';
import { Failure, Fill, Heading, Link, useBusy, useSettings, useText } from '../app';
import { day, digits, type Key } from '../i18n';
import { Account } from './Account';

type Problem = 'offline' | 'wait' | 'failed' | 'notAllowed' | 'taken' | 'badInput' | 'keyLate' | 'secretComment';
const problemIn = (error: unknown): Problem =>
  error instanceof CallError && error.status === 403 ? 'notAllowed' : error instanceof CallError && error.code === 'secret_found' ? 'secretComment' : error instanceof CallError && error.status === 422 ? 'badInput' : problemOf(error);

/** Loads once, and again on request. */
function useLoad<T>(path: string): { data: T | null; problem: 'offline' | 'wait' | 'failed' | null; load: () => void; set: (next: T | ((prev: T | null) => T | null)) => void } {
  const [data, set] = useState<T | null>(null), [problem, setProblem] = useState<'offline' | 'wait' | 'failed' | null>(null), [tries, setTries] = useState(0);
  useEffect(() => {
    const stop = new AbortController();
    setProblem(null);
    call<T>('GET', path, undefined, stop.signal).then(set, (error: unknown) => { if (!stop.signal.aborted) setProblem(problemOf(error)); });
    return () => stop.abort();
  }, [path, tries]);
  return { data, problem, load: () => setTries((n) => n + 1), set };
}

function Loading({ problem, load }: { problem: 'offline' | 'wait' | 'failed' | null; load: () => void }) {
  const t = useText();
  return problem ? <><Failure>{t(problem)}</Failure><button class="plain" onClick={load}>{t('retry')}</button></> : <p class="muted" role="status">{t('loading')}</p>;
}

const PARTS: [path: string, title: Key, who: 'all' | 'managers' | 'owner', need?: 'webhooks'][] = [
  ['/settings', 'account', 'all'], ['/settings/agents', 'agents', 'managers'], ['/settings/projects', 'projects', 'owner'], ['/settings/deleted', 'deletedPages', 'managers'], ['/settings/webhooks', 'webhooks', 'managers', 'webhooks'], ['/settings/data', 'data', 'owner'],
];

export function Settings({ path, me, onChange }: { path: string; me: Me; onChange: () => void }) {
  const t = useText();
  const parts = PARTS.filter(([, , who, need]) => (!need || me[need]) && (who === 'all' || me.isOwner || (who === 'managers' && me.manages)));
  const now = parts.find(([p]) => p === path) ?? parts[0]!;
  return (
    <>
      <Heading>{t('settings')}</Heading>
      <nav class="chips" aria-label={t('settings')}>{parts.map(([p, title]) => <Link key={p} class="chip" to={p} current={p === now[0]}>{t(title)}</Link>)}</nav>
      {now[0] === '/settings' && <Account me={me} onChange={onChange} inside />}
      {now[0] === '/settings/agents' && <Agents me={me} />}
      {now[0] === '/settings/projects' && <Projects />}
      {now[0] === '/settings/deleted' && <Deleted />}
      {now[0] === '/settings/webhooks' && <Webhooks />}
      {now[0] === '/settings/data' && <Data onChange={onChange} />}
    </>
  );
}

// ---- Agents and keys

const SCOPES = ['pages:read', 'pages:write', 'decisions:read', 'comments:read', 'comments:write'] as const;
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

function Agents({ me }: { me: Me }) {
  const t = useText(), { data, problem, load, set } = useLoad<{ items: Agent[] }>('/agents'), [making, setMaking] = useState(false), [made, setMade] = useState<string | null>(null);
  const newKey = useRef<HTMLButtonElement>(null), wasOpen = useRef(false), open = making || made !== null;
  useEffect(() => { if (!open && wasOpen.current) newKey.current?.focus(); wasOpen.current = open; }, [open]);
  const off = (agent: Agent, value: boolean) => call('PUT', `/agents/${agent.id}/off`, { off: value }).then(() => set((now) => now && { items: now.items.map((a) => (a.id === agent.id ? { ...a, disabledAt: value ? Date.now() : null } : a)) }));
  const revoke = (id: string) => call('DELETE', `/agent-keys/${id}`).then(() => set((now) => now && { items: now.items.map((a) => ({ ...a, keys: a.keys.map((k) => (k.id === id ? { ...k, revokedAt: Date.now() } : k)) })) }));
  if (data === null) return <Loading problem={problem} load={load} />;
  return (
    <>
      {made !== null && <NewKey secret={made} onDone={() => setMade(null)} />}
      {making && <MakeKey me={me} agents={data.items} onCancel={() => setMaking(false)} onMade={(secret) => { setMaking(false); setMade(secret); load(); }} />}
      {!making && made === null && <button ref={newKey} class="primary fit" onClick={() => setMaking(true)}>{t('newKey')}</button>}
      <p class="muted">{t('newKeyHelp')}</p>
      {data.items.length === 0 && <div class="card empty"><p>{t('noAgents')}</p></div>}
      <ul class="grid wide-cards">{data.items.map((agent) => <li key={agent.id}><AgentCard agent={agent} off={off} revoke={revoke} /></li>)}</ul>
    </>
  );
}

function AgentCard({ agent, off, revoke }: { agent: Agent; off: (agent: Agent, value: boolean) => Promise<void>; revoke: (id: string) => Promise<void> }) {
  const t = useText(), { lang } = useSettings(), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null), [asking, setAsking] = useState<string | null>(null);
  const act = (what: () => Promise<void>) => run(async () => { setProblem(null); try { await what(); setAsking(null); } catch (error) { setProblem(problemIn(error)); } });
  return (
    <section class="card">
      <h2><bdi dir="auto">{agent.name}</bdi>{agent.disabledAt !== null && <> <span class="status">{t('agentOff')}</span></>}</h2>
      {agent.keys.length === 0 && <p class="muted">{t('noKeys')}</p>}
      <ul class="rows">
        {agent.keys.map((key) => {
          const over = key.expiresAt <= Date.now(), dead = key.revokedAt !== null || over;
          return (
            <li key={key.id} data-dead={dead}>
              <div>
                <strong><bdi dir="auto">{key.label ?? t('noLabel')}</bdi></strong> {key.revokedAt !== null ? <span class="status">{t('revoked')}</span> : over && <span class="status">{t('ended')}</span>}
                <p class="muted">{key.allProjects ? t('allProjects') : key.projects.map((p, i) => <span key={p.slug}>{i > 0 && (lang === 'ar' ? '، ' : ', ')}<bdi>{p.name[lang]}</bdi></span>)}</p>
                <p class="muted">{key.scopes.map((s) => t(`scope ${s}` as Key)).join(lang === 'ar' ? '، ' : ', ')}</p>
                <p class="muted"><Fill text={over ? 'endedOn' : 'endsOn'} date={day(lang, key.expiresAt)} />{lang === 'ar' ? '، ' : ', '}{key.lastUsedAt === null ? t('neverUsed') : <Fill text="lastUsed" date={day(lang, key.lastUsedAt)} />}</p>
              </div>
              {!dead && (asking === key.id
                ? <div class="row"><button class="plain" disabled={busy} onClick={() => act(() => revoke(key.id))}>{t('revokeSure')}</button><button class="plain" disabled={busy} onClick={() => setAsking(null)}>{t('cancel')}</button></div>
                : <button class="plain" onClick={() => setAsking(key.id)}>{t('revoke')}</button>)}
            </li>
          );
        })}
      </ul>
      {problem && <Failure>{t(problem)}</Failure>}
      <button class="plain wide" disabled={busy} onClick={() => act(() => off(agent, agent.disabledAt === null))}>{t(agent.disabledAt === null ? 'turnAgentOff' : 'turnAgentOn')}</button>
    </section>
  );
}

/** The browser makes the secret and tells the server only its hash: it is shown here, once, and nowhere else. */
function MakeKey({ me, agents, onCancel, onMade }: { me: Me; agents: Agent[]; onCancel: () => void; onMade: (secret: string) => void }) {
  const t = useText(), { lang } = useSettings(), id = useId(), first = useRef<HTMLInputElement>(null), { data: projects, problem: projectsProblem, load } = useLoad<Listed<ProjectName & { level: number }>>('/projects'), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null);
  const [agent, setAgent] = useState(''), [label, setLabel] = useState(''), [days, setDays] = useState(90), [all, setAll] = useState(false), [chosen, setChosen] = useState<string[]>([]), [scopes, setScopes] = useState<string[]>([...SCOPES]);
  useEffect(() => first.current?.focus(), []);
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const ready = agent.trim() !== '' && scopes.length > 0 && (all || chosen.length > 0);
  const make = () => run(async () => {
    setProblem(null);
    try {
      const secret = b64(crypto.getRandomValues(new Uint8Array(32)));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), (b) => b.toString(16).padStart(2, '0')).join('');
      const { id: keyId } = await call<{ id: string }>('POST', '/agent-keys', { agent, secretSha256: hash, scopes, projects: all ? 'all' : chosen, days, ...(label.trim() && { label }) });
      onMade(`lawh_${keyId}_${secret}`);
    } catch (error) { setProblem(error instanceof CallError && error.status === 409 ? 'keyLate' : problemIn(error)); }
  });
  return (
    <form class="card form" onSubmit={(event) => { event.preventDefault(); if (ready) make(); }}>
      <h2>{t('newKey')}</h2>
      <label class="muted" for={`${id}-a`}>{t('agentName')}</label>
      <input ref={first} id={`${id}-a`} class="field" dir="auto" maxLength={60} list={`${id}-names`} autocomplete="off" value={agent} onInput={(event) => setAgent(event.currentTarget.value)} />
      <datalist id={`${id}-names`}>{agents.map((a) => <option key={a.id} value={a.name} />)}</datalist>
      <label class="muted" for={`${id}-l`}>{t('keyLabel')}</label>
      <input id={`${id}-l`} class="field" dir="auto" maxLength={60} autocomplete="off" value={label} onInput={(event) => setLabel(event.currentTarget.value)} />
      <label class="muted" for={`${id}-d`}>{t('keyDays')}</label>
      <select id={`${id}-d`} class="field" value={String(days)} onChange={(event) => setDays(Number(event.currentTarget.value))}>{[7, 30, 90, 180, 365].map((n) => <option key={n} value={String(n)} selected={n === days}>{digits(lang, n)}</option>)}</select>
      <fieldset class="checks"><legend class="muted">{t('projects')}</legend>
        {projects === null && <Loading problem={projectsProblem} load={load} />}
        {me.isOwner && <label class="check"><input type="checkbox" checked={all} onChange={() => setAll(!all)} /><span>{t('allProjects')}</span></label>}
        {!all && projects?.items.filter((p) => p.level >= 4).map((p) => <label key={p.slug} class="check"><input type="checkbox" checked={chosen.includes(p.slug)} onChange={() => setChosen(toggle(chosen, p.slug))} /><bdi>{p.name[lang]}</bdi></label>)}
      </fieldset>
      <fieldset class="checks"><legend class="muted">{t('may')}</legend>
        {SCOPES.map((s) => <label key={s} class="check"><input type="checkbox" checked={scopes.includes(s)} onChange={() => setScopes(toggle(scopes, s))} /><span>{t(`scope ${s}` as Key)}</span></label>)}
      </fieldset>
      <p class="muted">{t('keyLimits')}</p>
      {problem && <Failure>{t(problem)}</Failure>}
      <button class="primary" type="submit" disabled={!ready || busy}>{t('makeKey')}</button>
      <button class="plain wide" type="button" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
    </form>
  );
}

function NewKey({ secret, onDone }: { secret: string; onDone: () => void }) {
  const t = useText(), [copied, setCopied] = useState<boolean | null>(null), box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div class="card form" ref={box} tabIndex={-1}>
      <h2>{t('keyMade')}</h2>
      <p>{t('keyOnce')}</p>
      <p class="address" dir="ltr">{secret}</p>
      <p class="muted" dir="ltr">LAWH_URL={location.origin}</p>
      <div aria-live="polite">{copied !== null && <p class={copied ? 'done' : 'failure'}>{t(copied ? 'copied' : 'notCopied')}</p>}</div>
      <button class="primary" onClick={() => { navigator.clipboard.writeText(secret).then(() => setCopied(true), () => setCopied(false)); }}>{t('copy')}</button>
      <button class="plain wide" onClick={onDone}>{t('keySaved')}</button>
    </div>
  );
}

// ---- Projects

function Projects() {
  const t = useText(), { data, problem, load, set } = useLoad<Listed<ProjectName>>('/projects');
  if (data === null) return <Loading problem={problem} load={load} />;
  return (
    <>
      <ProjectForm onSave={async (slug, name) => { const made = await call<ProjectName>('POST', '/projects', { slug, name }); set((now) => now && { ...now, items: [...now.items, made] }); }} />
      <ul class="grid wide-cards">
        {data.items.map((p) => <li key={p.slug}><ProjectForm project={p} onSave={async (slug, name) => { const next = await call<ProjectName>('PATCH', `/projects/${slug}`, { name }); set((now) => now && { ...now, items: now.items.map((o) => (o.slug === slug ? { ...o, ...next } : o)) }); }} /></li>)}
      </ul>
      {data.items.length === 0 && <p class="muted">{t('noProjectsYet')}</p>}
    </>
  );
}

function ProjectForm({ project, onSave }: { project?: ProjectName; onSave: (slug: string, name: { en: string; ar: string }) => Promise<void> }) {
  const t = useText(), { lang } = useSettings(), id = useId(), [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null), [done, setDone] = useState(false), [open, setOpen] = useState(false), box = useRef<HTMLDivElement>(null), first = useRef<HTMLInputElement>(null), wasOpen = useRef(false);
  const [slug, setSlug] = useState(project?.slug ?? ''), [en, setEn] = useState(project?.name.en ?? ''), [ar, setAr] = useState(project?.name.ar ?? '');
  useEffect(() => { if (open) first.current?.focus(); else if (wasOpen.current) box.current?.focus(); wasOpen.current = open; }, [open]);
  const ready = /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) && en.trim() !== '' && ar.trim() !== '' && (!project || en.trim() !== project.name.en || ar.trim() !== project.name.ar);
  const save = () => run(async () => {
    setProblem(null); setDone(false);
    try { await onSave(slug, { en: en.trim(), ar: ar.trim() }); setDone(true); setOpen(false); if (!project) { setSlug(''); setEn(''); setAr(''); } } catch (error) { setProblem(error instanceof CallError && error.status === 409 ? 'taken' : problemIn(error)); }
  });
  if (!open) {
    return (
      <div ref={box} tabIndex={-1} class={project ? 'card' : 'form-closed'}>
        {project ? <><h2><bdi>{project.name[lang]}</bdi></h2><p class="muted" dir="ltr">{project.slug}</p><button class="plain wide" onClick={() => { setOpen(true); setDone(false); }}>{t('rename')}</button></> : <button class="primary fit" onClick={() => { setOpen(true); setDone(false); }}>{t('newProject')}</button>}
        <div aria-live="polite">{done && <p class="done">{t('saved')}</p>}</div>
      </div>
    );
  }
  return (
    <form class="card form" onSubmit={(event) => { event.preventDefault(); if (ready) save(); }}>
      <h2>{project ? <bdi>{project.name[lang]}</bdi> : t('newProject')}</h2>
      {!project && <><label class="muted" for={`${id}-s`}>{t('slug')}</label><input ref={first} id={`${id}-s`} class="field" dir="ltr" maxLength={80} autocomplete="off" autocapitalize="none" value={slug} onInput={(event) => setSlug(event.currentTarget.value.toLowerCase())} /><p class="muted">{t('slugHelp')}</p></>}
      <label class="muted" for={`${id}-e`}>{t('nameEn')}</label><input {...(project && { ref: first })} id={`${id}-e`} class="field" lang="en" dir="ltr" maxLength={80} autocomplete="off" value={en} onInput={(event) => setEn(event.currentTarget.value)} />
      <label class="muted" for={`${id}-r`}>{t('nameAr')}</label><input id={`${id}-r`} class="field" lang="ar" dir="rtl" maxLength={80} autocomplete="off" value={ar} onInput={(event) => setAr(event.currentTarget.value)} />
      {problem && <Failure>{t(problem)}</Failure>}
      <button class="primary" type="submit" disabled={!ready || busy}>{t('save')}</button>
      <button class="plain wide" type="button" disabled={busy} onClick={() => { setOpen(false); setProblem(null); setSlug(project?.slug ?? ''); setEn(project?.name.en ?? ''); setAr(project?.name.ar ?? ''); }}>{t('cancel')}</button>
    </form>
  );
}

// ---- Deleted pages

function Deleted() {
  const t = useText(), { lang } = useSettings(), { data, problem, load, set } = useLoad<Listed<DeletedPage>>('/deleted'), [busy, run] = useBusy(), [failed, setFailed] = useState<Problem | null>(null), [back, setBack] = useState<{ project: string; slug: string; title: string } | null>(null);
  if (data === null) return <Loading problem={problem} load={load} />;
  const act = (what: () => Promise<void>) => run(async () => { setFailed(null); try { await what(); } catch (error) { setFailed(problemIn(error)); } });
  return (
    <>
      <p class="muted">{t('deletedHelp')}</p>
      <div aria-live="polite">{back && <p class="done"><Fill text="restored" title={back.title} /> <Link class="text" to={`/p/${back.project}/${back.slug}`}>{t('open')}</Link></p>}</div>
      {data.items.length === 0 && <div class="card empty"><p>{t('noDeleted')}</p></div>}
      <ul class="rows card-rows">
        {data.items.map((p) => (
          <li key={p.id} class="card">
            <div><strong><bdi lang={p.lang}>{p.title}</bdi></strong><p class="muted"><bdi>{p.project.name[lang]}</bdi>{lang === 'ar' ? '، ' : ', '}<Fill text="goneOn" date={day(lang, p.purgedAfter)} /></p></div>
            <button class="plain" disabled={busy} onClick={() => act(async () => { const made = await call<{ project: string; slug: string }>('POST', `/deleted/${p.id}/restore`); set((now) => now && { ...now, items: now.items.filter((o) => o.id !== p.id) }); setBack({ ...made, title: p.title }); })}>{t('restore')}</button>
          </li>
        ))}
      </ul>
      {failed && <Failure>{t(failed)}</Failure>}
      {data.next && <button class="plain wide" disabled={busy} onClick={() => act(async () => { const next = await call<Listed<DeletedPage>>('GET', `/deleted?cursor=${data.next!}`); set((now) => now && { items: [...now.items, ...next.items], next: next.next }); })}>{t('more')}</button>}
    </>
  );
}

// ---- Webhooks

const EVENTS = ['page.published', 'page.status', 'decision.answered', 'decision.vote', 'decision.stale', 'comment.created', 'comment.resolved'] as const;

function Webhooks() {
  const t = useText(), { lang } = useSettings(), { data, problem, load, set } = useLoad<{ hosts: string[]; items: WebhookItem[]; failed: FailedDelivery[] }>('/webhooks');
  const [making, setMaking] = useState(false), [secret, setSecret] = useState<string | null>(null), [resent, setResent] = useState(false);
  const [busy, run] = useBusy(), [failed, setFailed] = useState<Problem | null>(null), [asking, setAsking] = useState<string | null>(null);
  const newBtn = useRef<HTMLButtonElement>(null), wasOpen = useRef(false), open = making || secret !== null;
  useEffect(() => { if (!open && wasOpen.current) newBtn.current?.focus(); wasOpen.current = open; }, [open]);
  if (data === null) return <Loading problem={problem} load={load} />;
  const act = (what: () => Promise<void>) => run(async () => { setFailed(null); setResent(false); try { await what(); setAsking(null); } catch (error) { setFailed(problemIn(error)); } });
  return (
    <>
      <p class="muted">{t('webhooksHelp')}</p>
      {secret !== null && <NewSecret secret={secret} onDone={() => setSecret(null)} />}
      {making && <MakeWebhook hosts={data.hosts} onCancel={() => setMaking(false)} onMade={(nextSecret) => { setMaking(false); setSecret(nextSecret); load(); }} />}
      {!making && secret === null && (data.hosts.length > 0
        ? <button ref={newBtn} class="primary fit" onClick={() => setMaking(true)}>{t('newWebhook')}</button>
        : <p class="muted">{t('noAllowedHosts')}</p>)}
      {data.items.length === 0 && <div class="card empty"><p>{t('noWebhooks')}</p></div>}
      <ul class="grid wide-cards">
        {data.items.map((w) => (
          <li key={w.id} class="card">
            <h2><bdi>{w.project.name[lang]}</bdi> <span class={w.enabled ? 'status decided' : 'status'}>{t(w.enabled ? 'webhookOn' : 'webhookOff')}</span></h2>
            <p class="address" dir="ltr">{w.url}</p>
            <p class="muted">{w.eventTypes.map((e) => t(`event ${e}` as Key)).join(lang === 'ar' ? '، ' : ', ')}</p>
            <p class="muted"><Fill text="createdBy" name={w.createdBy ?? t('formerMember')} />{lang === 'ar' ? '، ' : ', '}{day(lang, w.createdAt)}</p>
            <div class="row">
              <button class="plain" disabled={busy} onClick={() => act(async () => {
                await call('PATCH', `/webhooks/${w.id}`, { enabled: !w.enabled });
                set((now) => now && { ...now, items: now.items.map((o) => (o.id === w.id ? { ...o, enabled: !w.enabled } : o)) });
              })}>{t(w.enabled ? 'pauseWebhook' : 'resumeWebhook')}</button>
              {asking === w.id
                ? <><button class="plain danger" disabled={busy} onClick={() => act(async () => {
                  await call('DELETE', `/webhooks/${w.id}`);
                  set((now) => now && { ...now, items: now.items.filter((o) => o.id !== w.id), failed: now.failed.filter((f) => f.webhookId !== w.id) });
                })}>{t('deleteWebhookSure')}</button><button class="plain" disabled={busy} onClick={() => setAsking(null)}>{t('cancel')}</button></>
                : <button class="plain" disabled={busy} onClick={() => setAsking(w.id)}>{t('deleteWebhook')}</button>}
            </div>
          </li>
        ))}
      </ul>
      {data.failed.length > 0 && (
        <section class="card form">
          <h2>{t('failedDeliveries')}</h2>
          <div aria-live="polite">{resent && <p class="done">{t('resent')}</p>}</div>
          <ul class="rows">
            {data.failed.map((f) => (
              <li key={`${f.webhookId}:${f.eventSeq}`}>
                <div>
                  <strong>{t(`event ${f.eventType}` as Key)}</strong>
                  <p class="muted"><bdi>{f.project.name[lang]}</bdi>{lang === 'ar' ? '، ' : ', '}{f.lastCode === null ? t('networkError') : <Fill text="httpCode" code={digits(lang, f.lastCode)} />}{lang === 'ar' ? '، ' : ', '}{day(lang, f.updatedAt)}</p>
                </div>
                <button class="plain" disabled={busy} onClick={() => act(async () => {
                  await call('POST', `/webhooks/${f.webhookId}/deliveries/${f.eventSeq}/resend`);
                  set((now) => now && { ...now, failed: now.failed.filter((o) => !(o.webhookId === f.webhookId && o.eventSeq === f.eventSeq)) });
                  setResent(true);
                })}>{t('resend')}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {failed && <Failure>{t(failed)}</Failure>}
    </>
  );
}

function MakeWebhook({ hosts, onCancel, onMade }: { hosts: string[]; onCancel: () => void; onMade: (secret: string) => void }) {
  const t = useText(), { lang } = useSettings(), id = useId(), first = useRef<HTMLInputElement>(null);
  const { data: projects, problem: projectsProblem, load } = useLoad<Listed<ProjectName & { level: number }>>('/projects');
  const [busy, run] = useBusy(), [problem, setProblem] = useState<Problem | null>(null);
  const [project, setProject] = useState(''), [url, setUrl] = useState(''), [events, setEvents] = useState<string[]>([...EVENTS]);
  useEffect(() => first.current?.focus(), []);
  const managed = projects?.items.filter((p) => p.level >= 4) ?? [];
  const chosenProject = project || managed[0]?.slug || '';
  const toggle = (value: string) => setEvents((list) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]));
  const ready = chosenProject !== '' && url.trim().startsWith('https://') && events.length > 0;
  const save = () => run(async () => {
    setProblem(null);
    try {
      const made = await call<{ secret: string }>('POST', '/webhooks', { project: chosenProject, url: url.trim(), eventTypes: events });
      onMade(made.secret);
    } catch (error) { setProblem(problemIn(error)); }
  });
  return (
    <form class="card form" onSubmit={(event) => { event.preventDefault(); if (ready) save(); }}>
      <h2>{t('newWebhook')}</h2>
      {projects === null && <Loading problem={projectsProblem} load={load} />}
      {managed.length > 0 && (
        <>
          <label class="muted" for={`${id}-p`}>{t('projects')}</label>
          <select id={`${id}-p`} class="field" value={chosenProject} onChange={(event) => setProject(event.currentTarget.value)}>
            {managed.map((p) => <option key={p.slug} value={p.slug} selected={p.slug === chosenProject}>{p.name[lang]}</option>)}
          </select>
        </>
      )}
      <label class="muted" for={`${id}-u`}>{t('webhookUrl')}</label>
      <input ref={first} id={`${id}-u`} class="field" dir="ltr" maxLength={500} placeholder={`https://${hosts[0] ?? 'hooks.example.com'}/lawh`} autocomplete="off" value={url} onInput={(event) => setUrl(event.currentTarget.value)} />
      <p class="muted" dir="ltr">{hosts.join(', ')}</p>
      <fieldset class="checks"><legend class="muted">{t('webhookEvents')}</legend>
        {EVENTS.map((e) => <label key={e} class="check"><input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} /><span>{t(`event ${e}` as Key)}</span></label>)}
      </fieldset>
      {problem && <Failure>{t(problem)}</Failure>}
      <button class="primary" type="submit" disabled={!ready || busy}>{t('save')}</button>
      <button class="plain wide" type="button" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
    </form>
  );
}

function NewSecret({ secret, onDone }: { secret: string; onDone: () => void }) {
  const t = useText(), [copied, setCopied] = useState<boolean | null>(null), box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div class="card form" ref={box} tabIndex={-1}>
      <h2>{t('webhookSecret')}</h2>
      <p>{t('webhookSecretOnce')}</p>
      <p class="address" dir="ltr">{secret}</p>
      <div aria-live="polite">{copied !== null && <p class={copied ? 'done' : 'failure'}>{t(copied ? 'copied' : 'notCopied')}</p>}</div>
      <button class="primary" onClick={() => { navigator.clipboard.writeText(secret).then(() => setCopied(true), () => setCopied(false)); }}>{t('copy')}</button>
      <button class="plain wide" onClick={onDone}>{t('keySaved')}</button>
    </div>
  );
}

// ---- What the copy keeps, and taking it along

const KEEP = [null, 100, 50, 20, 10, 5, 1] as const;

function Data({ onChange }: { onChange: () => void }) {
  const t = useText(), { lang } = useSettings(), id = useId(), { data, problem, load, set } = useLoad<{ retention: number | null; webhooks: boolean; webhookHosts: string[] }>('/settings'), [busy, run] = useBusy(), [failed, setFailed] = useState<Problem | null>(null), [choice, setChoice] = useState<string | null>(null), [done, setDone] = useState(false);
  const [hostsDraft, setHostsDraft] = useState<string | null>(null), [hostsDone, setHostsDone] = useState(false);
  const [parts, setParts] = useState<{ after: string; last: string; files: number; bytes: number }[] | null>(null);
  if (data === null) return <Loading problem={problem} load={load} />;
  const act = (what: () => Promise<void>) => run(async () => { setFailed(null); setDone(false); setHostsDone(false); try { await what(); } catch (error) { setFailed(problemIn(error)); } });
  const now = data.retention === null ? '' : String(data.retention), value = choice ?? now, options = [...new Set([...KEEP, data.retention])];
  const hostsText = hostsDraft ?? data.webhookHosts.join('\n');
  // Fewer than now: versions go for good, so it is asked.
  const fewer = value !== '' && (now === '' || Number(value) < Number(now));
  return (
    <>
      <section class="card form">
        <h2>{t('retention')}</h2>
        <label class="muted" for={id}>{t('retentionHelp')}</label>
        <select id={id} class="field" value={value} onChange={(event) => { setChoice(event.currentTarget.value); setDone(false); }}>{options.map((n) => <option key={String(n)} value={n === null ? '' : String(n)} selected={value === (n === null ? '' : String(n))}>{n === null ? t('keepAll') : digits(lang, n)}</option>)}</select>
        {value !== now && fewer && <p class="failure">{t('retentionWarn')}</p>}
        <div aria-live="polite">{done && <p class="done">{t('saved')}</p>}</div>
        <button class="primary" disabled={busy || value === now} onClick={() => act(async () => { const next = await call<{ retention: number | null }>('PUT', '/settings/retention', { keep: value === '' ? null : Number(value) }); set((cur) => cur && { ...cur, retention: next.retention }); setChoice(null); setDone(true); })}>{t('save')}</button>
      </section>
      <section class="card form">
        <h2>{t('webhooks')}</h2>
        <p class="muted">{t('webhooksHelp')}</p>
        <p>{t(data.webhooks ? 'webhooksOn' : 'webhooksOff')}</p>
        <button class="plain wide" disabled={busy} onClick={() => act(async () => {
          const next = await call<{ webhooks: boolean }>('PUT', '/switches/webhooks', { on: !data.webhooks });
          set((cur) => cur && { ...cur, webhooks: next.webhooks });
          onChange();
        })}>{t(data.webhooks ? 'turnWebhooksOff' : 'turnWebhooksOn')}</button>
        <label class="muted" for={`${id}-h`}>{t('allowedHosts')}</label>
        <textarea id={`${id}-h`} class="field notes" dir="ltr" value={hostsText} onInput={(event) => { setHostsDraft(event.currentTarget.value); setHostsDone(false); }} />
        <p class="muted">{t('allowedHostsHelp')}</p>
        <div aria-live="polite">{hostsDone && <p class="done">{t('saved')}</p>}</div>
        <button class="primary" disabled={busy || hostsDraft === null} onClick={() => act(async () => {
          const list = hostsText.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
          const next = await call<{ webhookHosts: string[] }>('PUT', '/settings/webhook-hosts', { hosts: list });
          set((cur) => cur && { ...cur, webhookHosts: next.webhookHosts });
          setHostsDraft(null);
          setHostsDone(true);
        })}>{t('save')}</button>
      </section>
      <section class="card form">
        <h2>{t('export')}</h2>
        <p class="muted">{t('exportHelp')}</p>
        <a class="primary as-button" href="/app-api/export/rows" download>{t('exportRows')}</a>
        {parts === null && <button class="plain wide" disabled={busy} onClick={() => act(async () => { setParts((await call<{ parts: typeof parts }>('GET', '/export')).parts); })}>{t('exportFiles')}</button>}
        {parts?.length === 0 && <p class="muted">{t('noFiles')}</p>}
        <ul class="rows">
          {parts?.map((p, i) => <li key={p.after}><span><Fill text="part" n={digits(lang, i + 1)} total={digits(lang, parts.length)} /> <span class="muted"><Fill text="partSize" files={digits(lang, p.files)} size={digits(lang, (p.bytes / 1_000_000).toFixed(1))} /></span></span><a class="plain as-button" href={`/app-api/export/files?after=${p.after}&last=${p.last}&part=${i + 1}`} download>{t('download')}</a></li>)}
        </ul>
      </section>
      {failed && <Failure>{t(failed)}</Failure>}
    </>
  );
}
