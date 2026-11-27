import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { call, CallError, type Me, problemOf, type ProjectName, slugifyProject } from '../api';
import { Failure, Fill, go, Heading, useBusy, useSettings, useText } from '../app';

interface ConnectInfo {
  kind?: 'connect';
  id: string;
  client: string;
  machine: string;
  createdAt: number;
  expiresAt: number;
  agents: { id: string; name: string }[];
  projects: { slug: string; name: { en: string; ar: string } }[];
  requestedProject?: { slug: string; name: string } | null;
}

interface ProjectRequestInfo {
  kind: 'project';
  id: string;
  agentName: string;
  machine: string;
  slug: string;
  name: string;
  allProjects: boolean;
  createdAt: number;
  expiresAt: number;
}

type LookResult = ConnectInfo | ProjectRequestInfo;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** A signed-in owner or manager connects an agent or approves an agent's new-project request using the code shown by the client. */
export function Connect({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const t = useText(), { lang } = useSettings(), id = useId(), [busy, run] = useBusy();
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [projectReq, setProjectReq] = useState<ProjectRequestInfo | null>(null);
  const [pickedAgent, setPickedAgent] = useState('');
  const [newName, setNewName] = useState('');
  const [allProjects, setAllProjects] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [createRequested, setCreateRequested] = useState(false);
  const [reqName, setReqName] = useState('');
  const [reqSlug, setReqSlug] = useState('');
  const reqSlugTouched = useRef(false);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectSlug, setNewProjectSlug] = useState('');
  const [projectProblem, setProjectProblem] = useState<string | null>(null);
  const slugTouched = useRef(false);
  const newProjectBtn = useRef<HTMLButtonElement>(null);
  const projectNameInput = useRef<HTMLInputElement>(null);
  const wasAddingProject = useRef(false);
  const [result, setResult] = useState<'connected' | 'refused' | 'project_created' | 'project_refused' | null>(null);
  const [doneName, setDoneName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (addingProject) projectNameInput.current?.focus();
    else if (wasAddingProject.current) newProjectBtn.current?.focus();
    wasAddingProject.current = addingProject;
  }, [addingProject]);

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
      if (bad) { setInfo(null); setProjectReq(null); }
      if (error instanceof CallError && error.status === 403) { setProblem(t('projectReqOwnerOnly')); return; }
      if (error instanceof CallError && error.code === 'conflict') {
        setProblem(t(error.details?.reason === 'slug_taken' ? 'taken' : 'connectConflict'));
        return;
      }
      if (error instanceof CallError && error.status === 422) { setProblem(t('badInput')); return; }
      setProblem(t(bad ? 'badCode' : problemOf(error)));
    }
  });

  const lookUp = () => step(async () => {
    const found = await call<LookResult>('POST', '/connect/look', { code });
    setAddingProject(false);
    setNewProjectName('');
    setNewProjectSlug('');
    setProjectProblem(null);
    slugTouched.current = false;

    if (found.kind === 'project') {
      setInfo(null);
      setProjectReq(found);
      setReqName(found.name);
      setReqSlug(found.slug);
      reqSlugTouched.current = true;
      return;
    }

    setProjectReq(null);
    setInfo(found);
    const matching = found.agents.find((a) => a.name.toLowerCase() === found.client.toLowerCase());
    if (matching) {
      setPickedAgent(matching.id);
      setNewName('');
    } else {
      setPickedAgent('__new__');
      setNewName(found.client);
    }

    const req = found.requestedProject ?? null;
    if (req && me.isOwner) {
      const existing = found.projects.find((p) => p.slug === req.slug);
      if (existing) {
        setCreateRequested(false);
        setReqName('');
        setReqSlug('');
        setAllProjects(false);
        setProjects([existing.slug]);
      } else {
        setCreateRequested(true);
        setReqName(req.name);
        setReqSlug(req.slug);
        reqSlugTouched.current = true;
        setAllProjects(false);
        setProjects([]);
      }
    } else {
      setCreateRequested(false);
      setReqName('');
      setReqSlug('');
      setAllProjects(me.isOwner && found.projects.length > 0);
      setProjects(found.projects.length === 1 ? [found.projects[0]!.slug] : []);
    }
  });

  const toggleProject = (slug: string) => setProjects((list) => (list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug]));
  const usingNew = pickedAgent === '__new__' || (info?.agents.length ?? 0) === 0;
  const reqProjectValid = SLUG_RE.test(reqSlug) && reqName.trim().length > 0;
  const ready = info !== null
    && (usingNew ? newName.trim().length > 0 : pickedAgent !== '')
    && (!createRequested || reqProjectValid)
    && (allProjects || projects.length > 0 || createRequested);
  const newProjectReady = SLUG_RE.test(newProjectSlug) && newProjectName.trim().length > 0;

  const openNewProject = () => {
    setProjectProblem(null);
    setNewProjectName('');
    setNewProjectSlug('');
    slugTouched.current = false;
    setAddingProject(true);
  };

  const closeNewProject = () => {
    setAddingProject(false);
    setProjectProblem(null);
    setNewProjectName('');
    setNewProjectSlug('');
    slugTouched.current = false;
  };

  const createProject = () => run(async () => {
    if (!newProjectReady) return;
    setProjectProblem(null);
    const trimmed = newProjectName.trim();
    try {
      const made = await call<ProjectName>('POST', '/projects', {
        slug: newProjectSlug,
        name: { en: trimmed, ar: trimmed },
      });
      setInfo((cur) => (cur ? {
        ...cur,
        projects: cur.projects.some((p) => p.slug === made.slug)
          ? cur.projects
          : [...cur.projects, { slug: made.slug, name: made.name }],
      } : cur));
      setAllProjects(false);
      setProjects((list) => (list.includes(made.slug) ? list : [...list, made.slug]));
      closeNewProject();
    } catch (error) {
      if (error instanceof CallError && error.status === 401) { onSignedOut(); return; }
      if (error instanceof CallError && error.status === 409) { setProjectProblem(t('taken')); return; }
      if (error instanceof CallError && error.status === 422) { setProjectProblem(t('badInput')); return; }
      setProjectProblem(t(problemOf(error)));
    }
  });

  const onNewProjectKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (newProjectReady && !busy) createProject();
  };

  const approve = () => step(async () => {
    if (!info) return;
    const payload = {
      id: info.id,
      code,
      ...(usingNew ? { agentName: newName.trim() } : { agentId: pickedAgent }),
      projects: allProjects ? 'all' : projects,
      ...(createRequested ? { createProject: { slug: reqSlug, name: reqName.trim() } } : {}),
    };
    const res = await call<{ agentName: string }>('POST', '/connect/answer', payload);
    setDoneName(res.agentName);
    setResult('connected');
  });

  const refuse = () => step(async () => {
    if (!info) return;
    await call('POST', '/connect/answer', { id: info.id, code, refuse: true });
    setResult('refused');
  });

  const approveProjectReq = () => step(async () => {
    if (!projectReq || !reqProjectValid) return;
    const res = await call<{ project: ProjectName }>('POST', '/connect/answer', {
      kind: 'project',
      id: projectReq.id,
      code,
      name: reqName.trim(),
      slug: reqSlug,
    });
    setDoneName(res.project.name[lang]);
    setResult('project_created');
  });

  const refuseProjectReq = () => step(async () => {
    if (!projectReq) return;
    await call('POST', '/connect/answer', { kind: 'project', id: projectReq.id, code, refuse: true });
    setResult('project_refused');
  });

  return (
    <section class="card narrow">
      {result === 'connected' ? (
        <>
          <Heading key="connected">{t('connectTitle')}</Heading>
          <p role="status"><Fill text="connectDone" name={doneName} /></p>
        </>
      ) : result === 'refused' ? (
        <>
          <Heading key="refused">{t('connectTitle')}</Heading>
          <p role="status">{t('connectRefused')}</p>
        </>
      ) : result === 'project_created' ? (
        <>
          <Heading key="project-created">{t('projectReqTitle')}</Heading>
          <p role="status"><Fill text="projectReqDone" name={doneName} /></p>
        </>
      ) : result === 'project_refused' ? (
        <>
          <Heading key="project-refused">{t('projectReqTitle')}</Heading>
          <p role="status">{t('projectReqRefused')}</p>
        </>
      ) : projectReq !== null ? (
        <form onSubmit={(event) => { event.preventDefault(); if (reqProjectValid) approveProjectReq(); }}>
          <Heading key="project-req">{t('projectReqTitle')}</Heading>
          <p class="muted"><Fill text="projectReqClaim" agent={projectReq.agentName} /></p>
          <p class="muted">{t('connectWarn')}</p>
          <label class="muted" for={`${id}-rname`}>{t('projectName')}</label>
          <input
            id={`${id}-rname`}
            class="field"
            dir="auto"
            maxLength={80}
            autocomplete="off"
            required
            value={reqName}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setReqName(next);
              if (!reqSlugTouched.current) setReqSlug(slugifyProject(next));
            }}
          />
          <label class="muted" for={`${id}-rslug`}>{t('slug')}</label>
          <input
            id={`${id}-rslug`}
            class="field"
            dir="ltr"
            maxLength={80}
            autocomplete="off"
            autocapitalize="none"
            required
            value={reqSlug}
            onInput={(event) => {
              reqSlugTouched.current = true;
              setReqSlug(event.currentTarget.value.toLowerCase());
            }}
          />
          <p class="muted">{t('slugHelp')}</p>
          <p class="muted"><Fill text="projectReqGrantNote" agent={projectReq.agentName} /></p>
          <button class="primary" type="submit" disabled={!reqProjectValid || busy}>{t('projectReqApprove')}</button>
          <button class="plain wide" type="button" disabled={busy} onClick={refuseProjectReq}>{t('notMine')}</button>
        </form>
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
            {me.isOwner && info.requestedProject && !info.projects.some((p) => p.slug === info.requestedProject!.slug) && (
              <>
                <label class="check">
                  <input type="checkbox" checked={createRequested} onChange={(event) => setCreateRequested(event.currentTarget.checked)} />
                  <span><Fill text="createRequestedProject" name={reqName.trim() || info.requestedProject.name} /></span>
                </label>
                {createRequested && (
                  <div class="card form">
                    <label class="muted" for={`${id}-crname`}>{t('projectName')}</label>
                    <input
                      id={`${id}-crname`}
                      class="field"
                      dir="auto"
                      maxLength={80}
                      autocomplete="off"
                      value={reqName}
                      onInput={(event) => {
                        const next = event.currentTarget.value;
                        setReqName(next);
                        if (!reqSlugTouched.current) setReqSlug(slugifyProject(next));
                      }}
                    />
                    <label class="muted" for={`${id}-crslug`}>{t('slug')}</label>
                    <input
                      id={`${id}-crslug`}
                      class="field"
                      dir="ltr"
                      maxLength={80}
                      autocomplete="off"
                      autocapitalize="none"
                      value={reqSlug}
                      onInput={(event) => {
                        reqSlugTouched.current = true;
                        setReqSlug(event.currentTarget.value.toLowerCase());
                      }}
                    />
                    <p class="muted">{t('slugHelp')}</p>
                  </div>
                )}
              </>
            )}
            {me.isOwner && info.projects.length > 0 && (
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
            {me.isOwner && info.projects.length === 0 && !createRequested && !addingProject && <p class="muted">{t('noProjectsYet')}</p>}
          </fieldset>
          {me.isOwner && !addingProject && (
            <button ref={newProjectBtn} class="plain wide" type="button" disabled={busy} onClick={openNewProject}>{t('newProject')}</button>
          )}
          {me.isOwner && addingProject && (
            <div class="card form">
              <h2>{t('newProject')}</h2>
              <label class="muted" for={`${id}-pname`}>{t('projectName')}</label>
              <input
                ref={projectNameInput}
                id={`${id}-pname`}
                class="field"
                dir="auto"
                maxLength={80}
                autocomplete="off"
                value={newProjectName}
                onInput={(event) => {
                  const next = event.currentTarget.value;
                  setNewProjectName(next);
                  if (!slugTouched.current) setNewProjectSlug(slugifyProject(next));
                }}
                onKeyDown={onNewProjectKeyDown}
              />
              <label class="muted" for={`${id}-pslug`}>{t('slug')}</label>
              <input
                id={`${id}-pslug`}
                class="field"
                dir="ltr"
                maxLength={80}
                autocomplete="off"
                autocapitalize="none"
                value={newProjectSlug}
                onInput={(event) => {
                  slugTouched.current = true;
                  setNewProjectSlug(event.currentTarget.value.toLowerCase());
                }}
                onKeyDown={onNewProjectKeyDown}
              />
              <p class="muted">{t('slugHelp')}</p>
              {projectProblem && <Failure>{projectProblem}</Failure>}
              <button class="primary" type="button" disabled={!newProjectReady || busy} onClick={createProject}>{t('addProjectToTeam')}</button>
              <button class="plain wide" type="button" disabled={busy} onClick={closeNewProject}>{t('cancel')}</button>
            </div>
          )}
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
