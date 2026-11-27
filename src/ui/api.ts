export class CallError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Calls the app's own API. A network failure is a CallError with status 0. */
export async function call<T = undefined>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/app-api${path}`, { method, ...(method !== 'GET' && { body: JSON.stringify(body ?? {}), headers: { 'Content-Type': 'application/json' } }), cache: 'no-store', ...(signal && { signal }) });
  } catch { throw new CallError(0, 'offline'); }
  // Signed out, or the session is over: the app shows its sign-in, at the same address.
  if (response.status === 401) dispatchEvent(new Event('lawh:signed-out'));
  if (!response.ok) throw new CallError(response.status, await response.json().then((b: { code?: string }) => b.code ?? 'internal', () => 'internal'));
  if (response.status === 202) return 'waiting' as T;
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

/** What to tell the person. */
export const problemOf = (error: unknown): 'offline' | 'wait' | 'failed' =>
  !(error instanceof CallError) ? 'failed' : error.status === 0 ? 'offline' : error.status === 429 ? 'wait' : 'failed';

/** Turns a project name into a URL-safe slug (empty if the name has no ASCII letters or digits). */
export const slugifyProject = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');

export interface ProjectName { slug: string; name: { en: string; ar: string }; answersNeeded?: number; answerers?: number }
export type Status = 'draft' | 'in_review' | 'decided' | 'archived';
export interface PageItem { id: string; project: ProjectName; slug: string; title: string; summary: string; lang: 'en' | 'ar'; tags: string[]; status: Status; currentVersion: number; updatedAt: number }
export interface Version { n: number; note: string; publishedBy: string; createdAt: number }
export interface Reading extends PageItem { level: number; version: Version; frame: string; viewer: string }
export interface Listed<T> { items: T[]; next: string | null }

export interface Answer { seq: number; revision: number; question: string; optionId: string | null; optionLabel: string | null; notes: string; answeredAt: number; answeredBy: { id: string; name: string | null }; needed: number; decides: boolean }
export interface Decision {
  id: string; project: string; projectName: { en: string; ar: string }; page: { slug: string; title: string; lang: 'en' | 'ar'; status: Status }; revision: number; status: 'open' | 'answered' | 'stale' | 'withdrawn';
  question: string; context: string; options: { id: string; label: string; detail?: string; cost?: string }[]; answer: Answer | null; answersNeeded: number; agreement: Answer[]; answerSeq: number; mayAnswer: boolean; history?: Answer[];
  /** On the list of open ones: how many people can answer, when more than one must agree. */
  answerers?: number | null;
}

export interface Comment {
  id: string; threadId: string; authorType: 'person' | 'agent'; person: { id: string; name: string | null } | null; fromDecider: boolean; agent: string | null; versionN: number;
  sectionId: string | null; sectionTitle: string | null; quote: string | null; body: string; createdAt: number; resolvedAt: number | null; mayDelete: boolean;
}
export interface Thread extends Comment {
  replies: Comment[]; moreReplies: string | null; mayReply: boolean; mayResolve: boolean;
  project?: string; projectName?: { en: string; ar: string }; page?: { slug: string; title: string; lang: 'en' | 'ar' };
}

export interface AgentKey { id: string; label: string | null; scopes: string[]; allProjects: boolean; projects: ProjectName[]; createdAt: number; expiresAt: number; lastUsedAt: number | null; revokedAt: number | null }
export interface Agent { id: string; name: string; createdAt: number; disabledAt: number | null; owner?: { id: string; name: string | null }; isMine?: boolean; keys: AgentKey[] }
export interface TeamMemberItem { id: string; name: string | null; level: number; setAt: number }
export interface TeamItem { id: string; name: string; createdAt: number; members: TeamMemberItem[]; projects: ProjectName[] }
export interface TeamsResponse { items: TeamItem[]; availableMembers: { id: string; name: string }[]; availableProjects: ProjectName[] }
export interface PersonMember { id: string; name: string; createdAt: number; joinedAt: number; resetExpiresAt: number | null; teams: { id: string; name: string; level: number }[] }
export interface PendingInvite { id: string; name: string; teamId: string | null; teamName: string | null; level: number | null; inviter: string | null; createdAt: number; expiresAt: number | null; expired: boolean; canRenew: boolean; canCancel: boolean }
export interface PeopleResponse { members: PersonMember[]; membersNext: string | null; invites: PendingInvite[]; invitesNext: string | null; teams: { id: string; name: string }[] }
export interface MyActiveKey { id: string; agentId: string; agentName: string; label: string | null; createdAt: number; expiresAt: number; lastUsedAt: number | null }
export interface DeletedPage { id: string; project: ProjectName; slug: string; title: string; lang: 'en' | 'ar'; deletedAt: number; purgedAfter: number }
export interface WebhookItem { id: string; project: ProjectName; url: string; eventTypes: string[]; enabled: boolean; createdBy: string | null; createdAt: number }
export interface FailedDelivery { webhookId: string; eventSeq: number; url: string; project: ProjectName; eventType: string; attempts: number; lastCode: number | null; updatedAt: number; eventAt: number }

/** `manages`: manages at least one project. `managesTeam`: manages at least one team. */
export interface Me { id: string; name: string; isOwner: boolean; instance: boolean; manages: boolean; managesTeam: boolean; webhooks: boolean; teams: boolean }
