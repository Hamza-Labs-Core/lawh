import { useId, useState } from 'preact/hooks';
import { call, CallError, type Me, problemOf } from '../api';
import { Failure, Fill, go, Heading, useBusy, useSettings, useText } from '../app';

interface ConnectInfo {
  id: string;
  client: string;
  machine: string;
  createdAt: number;
  expiresAt: number;
  agents: { id: string; name: string }[];
  projects: { slug: string; name: { en: string; ar: string } }[];
}

/** A signed-in owner or manager connects an agent using the code shown by the client. */
export function Connect({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const t = useText(), { lang } = useSettings(), id = useId(), [busy, run] = useBusy();
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [pickedAgent, setPickedAgent] = useState('');
  const [newName, setNewName] = useState('');
  const [allProjects, setAllProjects] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [result, setResult] = useState<'connected' | 'refused' | null>(null);
  const [connectedName, setConnectedName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (!me.isOwner && !me.manages) {
    return (
      <section class="card narrow">
        <Heading>{t('connectTitle')}</Heading>
        <p class="muted">{t('connectManagersOnly')}</p>
        <button class="plain wide" onClick={() => go('/')}>{t('back')}</button>
      </section>
    );
  }

  const step = (work: () => Promise<void>) => run(async () => {
    setProblem(null);
    try { await work(); } catch (error) {
      if (error instanceof CallError && error.status === 401) { onSignedOut(); return; }
      const bad = error instanceof CallError && error.status === 404;
      if (bad) setInfo(null);
      if (error instanceof CallError && error.code === 'conflict') { setProblem(t('connectConflict')); return; }
      setProblem(t(bad ? 'badCode' : problemOf(error)));
    }
  });

  const lookUp = () => step(async () => {
    const found = await call<ConnectInfo>('POST', '/connect/look', { code });
    setInfo(found);
    const matching = found.agents.find((a) => a.name.toLowerCase() === found.client.toLowerCase());
    if (matching) {
      setPickedAgent(matching.id);
      setNewName('');
    } else {
      setPickedAgent('__new__');
      setNewName(found.client);
    }
    setAllProjects(me.isOwner && found.projects.length > 0);
    setProjects(found.projects.length === 1 ? [found.projects[0]!.slug] : []);
  });

  const toggleProject = (slug: string) => setProjects((list) => (list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug]));
  const usingNew = pickedAgent === '__new__' || (info?.agents.length ?? 0) === 0;
  const ready = info !== null && (usingNew ? newName.trim().length > 0 : pickedAgent !== '') && (allProjects || projects.length > 0);

  const approve = () => step(async () => {
    if (!info) return;
    const payload = {
      id: info.id,
      code,
      ...(usingNew ? { agentName: newName.trim() } : { agentId: pickedAgent }),
      projects: allProjects ? 'all' : projects,
    };
    const res = await call<{ agentName: string }>('POST', '/connect/answer', payload);
    setConnectedName(res.agentName);
    setResult('connected');
  });

  const refuse = () => step(async () => {
    if (!info) return;
    await call('POST', '/connect/answer', { id: info.id, code, refuse: true });
    setResult('refused');
  });

  return (
    <section class="card narrow">
      {result === 'connected' ? (
        <>
          <Heading key="connected">{t('connectTitle')}</Heading>
          <p role="status"><Fill text="connectDone" name={connectedName} /></p>
        </>
      ) : result === 'refused' ? (
        <>
          <Heading key="refused">{t('connectTitle')}</Heading>
          <p role="status">{t('connectRefused')}</p>
        </>
      ) : info === null ? (
        <form onSubmit={(event) => { event.preventDefault(); lookUp(); }}>
          <Heading key="code">{t('connectTitle')}</Heading>
          <label class="muted" for={`${id}-code`}>{t('connectHelp')}</label>
          <input id={`${id}-code`} class="field code" dir="ltr" autocomplete="off" autocapitalize="characters" spellcheck={false} maxLength={40} required value={code} onInput={(event) => setCode(event.currentTarget.value)} />
          <p class="muted">{t('connectWarn')}</p>
          <button class="primary" type="submit" disabled={busy}>{t('next')}</button>
        </form>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); if (ready) approve(); }}>
          <Heading key="details">{t('connectDetails')}</Heading>
          <p class="muted"><Fill text="connectClaim" client={info.client} machine={info.machine} /></p>
          <p class="muted">{t('connectWarn')}</p>
          {info.agents.length > 0 && (
            <>
              <label class="muted" for={`${id}-pick`}>{t('agentName')}</label>
              <select id={`${id}-pick`} class="field" value={pickedAgent} onChange={(event) => setPickedAgent(event.currentTarget.value)}>
                {info.agents.map((a) => <option key={a.id} value={a.id} selected={pickedAgent === a.id}>{a.name}</option>)}
                <option value="__new__" selected={pickedAgent === '__new__'}>{t('newAgentOption')}</option>
              </select>
            </>
          )}
          {usingNew && (
            <>
              <label class="muted" for={`${id}-name`}>{t('newAgentName')}</label>
              <input id={`${id}-name`} class="field" maxLength={60} required value={newName} onInput={(event) => setNewName(event.currentTarget.value)} />
            </>
          )}
          <fieldset class="checks">
            <legend class="muted">{t('projects')}</legend>
            {me.isOwner && (
              <label class="check">
                <input type="checkbox" checked={allProjects} onChange={(event) => setAllProjects(event.currentTarget.checked)} />
                <span>{t('allProjects')}</span>
              </label>
            )}
            {!allProjects && info.projects.map((p) => (
              <label key={p.slug} class="check">
                <input type="checkbox" checked={projects.includes(p.slug)} onChange={() => toggleProject(p.slug)} />
                <span><bdi>{p.name[lang]}</bdi></span>
              </label>
            ))}
          </fieldset>
          <p class="muted">{t('connectGrantNote')}</p>
          <button class="primary" type="submit" disabled={!ready || busy}>{t('connectApprove')}</button>
          <button class="plain wide" type="button" disabled={busy} onClick={refuse}>{t('notMine')}</button>
        </form>
      )}
      {problem && <Failure>{problem}</Failure>}
      <button class="plain wide" type="button" onClick={() => go('/')}>{t('back')}</button>
    </section>
  );
}
