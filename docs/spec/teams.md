# People and teams

A copy of Lawh can be used by one person or by several. One person needs nothing from this document: the owner can do everything, and the Teams screens stay hidden until the `teams` switch is on (off by default).

## People

- **One owner** for each copy, the person who set it up. `lawh owner transfer <member>` moves the role in one transaction, with the old owner's agents. It is a command, not a screen, because the owner is whoever controls the Cloudflare account.
- **Members** are invited. There is no sign-up page, no password and no email: Lawh stores a display name and passkeys, and sends no mail.
- Everyone signs in with a passkey. A session belongs to one member.

| What happens | How |
|---|---|
| **Invite** | The owner, or a manager for their own team, enters a name, a team and a level, and gets a link to send however they like. It works once, for 3 days. Opening it shows the copy's name, who invited and the team, and registers a passkey |
| **Lost devices** | The owner makes a reset link: once, for 1 day. Using it removes that member's other passkeys, sessions, approvals and challenges. Managers can't make one, because it signs its user in as that member in every team |
| **Owner's lost devices** | `lawh owner setup` (security.md section 4) |
| **Remove** | One change ends sessions, passkeys, approvals, links and memberships, cancels invites the member made that nobody has used, and revokes their agents' keys. It can't be undone; coming back is a new invite |
| **After removal** | Answers and comments stay, under the member's name. After 30 days the name is cleared and they show "Former member" |

The owner could make a reset link and sign in as a member. Every link is in the audit log, and the member's passkey stops working, so they notice. The owner controls the database in any case, so Lawh doesn't claim to protect members from the owner.

## Teams

A team is a name, its people and its projects. **Access comes only through teams:** a person sees a project when one of their teams has it. A person can be in several teams and a project in several teams; the highest level counts. A project in no team is the owner's alone, which is how every project starts.

A person's level is set once per team:

| | Viewer | Commenter | Decider | Manager | Owner |
|---|---|---|---|---|---|
| Read pages, versions, decisions, comments; search | ✓ | ✓ | ✓ | ✓ | ✓ |
| Start threads and reply | | ✓ | ✓ | ✓ | ✓ |
| Delete their own comments, resolve threads they started | | ✓ | ✓ | ✓ | ✓ |
| Answer decisions, resolve any thread | | | ✓ | ✓ | ✓ |
| Page status, delete and restore a page, delete any comment | | | | ✓ | ✓ |
| Agents and keys for the project; its webhooks | | | | ✓ | ✓ |
| Invite and remove people in the team, up to decider | | | | ✓ | ✓ |
| Make managers; reset or remove a person from the copy | | | | | ✓ |
| Projects, teams, which team has which project | | | | | ✓ |
| Switches, retention, allowed webhook hosts, export, audit log | | | | | ✓ |

In the four rows about pages, agents and webhooks, "manager" means a manager of a team that has that project. In the row about people, it means a manager of that team.

- A manager adds someone who already joined by choosing their name, and can't change or remove another manager.
- Someone without access to a project gets 404 for it, never 403, so names and slugs don't show.
- A person has at most 50 projects through their teams; a change that would go over gets 409. Lists then run one indexed query a project and merge, and search adds the projects as filters inside the index.

## Decisions in a team

- Whoever answers must be a decider on the project **at that moment**: a trigger refuses the row otherwise, so a removal can't race an answer.
- Each answer records who gave it. The page, the history and the API show the name.
- Two people answering at once: the first wins, the second gets 409 with the first answer shown.
- Whether one answer is enough is owner decision 5.
- "Open decisions" shows a person only what they may answer. Below decider, decisions are read only.

## Agents in a team

- An agent belongs to one person. A manager's agent gets keys only for projects that person manages.
- **This is checked on every request**, not only when the key is made: a key works in a project while its agent's person is the owner or still manages that project. Losing the level stops the key there at once.
- `all projects` keys are for the owner's agents only.
- The owner can take over an agent before removing its person, so that its keys keep working.
- The API marks each person's comment with their level when they wrote it, and `fromDecider`. Agents act on answers and on comments from deciders, managers and the owner; other comments are information (security.md section 8).

## Where it is enforced

| Rule | Where |
|---|---|
| Who may answer; level on a comment; who sets which level; links; passkeys, approvals and sessions per member; removal; one owner | Triggers and constraints in [schema.sql](schema.sql), tested in [integrity.py](checks/integrity.py) |
| Project access on every read and write | One server function, `levelOn(member, project)`, used by every `/app-api` route from S5 on. A test calls every route at every level, and fails if a route has no row in the table above |
| The `teams` switch | Server: while off, only the owner's session and agents work, and every other member gets 404 `feature_off` |

Access to a page's files ends when its content link does. Removing a person ends their session at once, but a link they already opened keeps working for up to 4 hours; it opens one version of a page they had already read.

## Not in v1

Single sign-on (SAML, OIDC), groups inside teams, access to a single page, assigning a decision to one person, mentions, email notices, several copies sharing people.
