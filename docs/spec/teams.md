# People and teams

A copy of Lawh can be used by one person or by several. One person needs nothing from this document: the owner can do everything, and the Teams screens stay hidden until the `teams` switch is on (off by default).

## People

- **One owner** for each copy, the person who set it up. `lawh owner transfer <member>` moves the role in one transaction, to a member who has joined. Both people leave every team, and every unused link made for or by either of them is deleted. The old owner's agents move too and lose their keys, so the new owner makes new ones; an agent whose name the new owner already uses gets its id added. People invited by a deleted link are canceled. The command says all this before it asks for a yes. It is a command, not a screen, because the owner is whoever controls the Cloudflare account.
- **Members** are invited. There is no sign-up page, no password and no email: Lawh stores a display name and passkeys, and sends no mail.
- Everyone signs in with a passkey. A session belongs to one member.

| What happens | How |
|---|---|
| **Invite** | The owner, or a manager for their own team, enters a name, a team and a level, and gets a link to send however they like. It works once, for 3 days. The team and level are in the link: **an invited person is in no team and has no access until they join**, and the database checks then that whoever made the link can still give that level. Opening it shows the copy's name, who invited, the team and the level, and registers a passkey |
| **Cancel an invite** | Deletes the link and marks the person removed. The inviter, a manager of that team or the owner can. An invite nobody used stays in the team's list, also after its link expires, and is canceled after 30 days, or when its team is deleted. Making a new link for the same person replaces the old one |
| **Lost devices** | The owner makes a reset link: once, for 1 day. Using it removes that member's other passkeys, sessions, approvals and challenges. Managers can't make one, because it signs its user in as that member in every team |
| **Owner's lost devices** | `lawh owner setup` (security.md section 4) |
| **Remove** | One change ends sessions, passkeys, approvals, links and memberships, cancels invites the member made that nobody has used, with their links whoever made them, and revokes their agents' keys. It can't be undone; coming back is a new invite |
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

In the two rows about page status and agents, "manager" means a manager of a team that has that project. In the row about people, it means a manager of that team.

- A manager adds someone who already joined by choosing their name, and can't change or remove another manager. Removing from a team is one `DELETE` that carries its own conditions (not a manager, and the actor manages the team), so it can't race a promotion.
- Someone without access to a project gets 404 for it, never 403, so names and slugs don't show.
- **Limits: 5 teams a person and 10 projects a team**, checked by triggers, so a person has at most 50 projects. A change that would go over gets 409. Lists and the open-decisions screen run one indexed query a project and merge, and search adds the projects as filters inside the index.

## Decisions in a team

- Whoever answers must be a decider on the project **at that moment**: a trigger refuses the row otherwise, so a removal can't race an answer.
- Each answer records who gave it. The page, the history and the API show the name.
- Two people answering at once: the first wins, the second gets 409 with the first answer shown.
- Whether one answer is enough is owner decision 5.
- "Open decisions" shows a person only what they may answer. Below decider, decisions are read only.

## Agents in a team

- An agent belongs to the person who connected it. A manager's agent gets keys only for projects that person manages.
- **This is checked on every request**, not only when the key is made: a key works in a project while its agent's person is the owner or still manages that project. Losing the level stops the key there at once.
- `all projects` keys are for the owner's agents only.
- **An agent that moves to another person loses its keys**, because the old person still has the secrets. The owner can take over an agent to keep its history, with a new name if the owner already uses that one, then makes it a new key.
- Agent names are unique for each person, not for the copy. The UI shows "claude-agent (Mona)".
- Routes without a project in the path (send a blob, commit, read a decision, comments, reply) find the project from the row and check it the same way. A publish whose person lost the level fails at the next blob or at commit.
- A webhook belongs to its project, not to who made it, and stays when that person leaves. It can send only ids and event types, to hosts the owner allowed. The list shows who made it.
- The API marks a person's comment with `fromDecider`: whether they could decide there when they wrote it. Agents act on answers and on comments from deciders, managers and the owner; other comments are information (security.md section 8).

## Where it is enforced

| Rule | Where |
|---|---|
| Who may answer; level on a comment, and that it stays in its page's project; who sets which level; limits; links; passkeys, approvals and sessions per member; removal; transfer; keys when an agent moves; one owner | Triggers and constraints in [schema.sql](schema.sql), tested in [integrity.py](checks/integrity.py) |
| Project access on every read and write | One server function, `levelOn(member, project)`, used by every `/app-api` route from S5 on. A test calls every route at every level, and fails if a route has no row in the table above |
| The `teams` switch | Server: while off, only the owner's session and agents work. Everything else for other people answers 404 `feature_off`: sessions, sign-in, device approval, connecting agents, invite and reset links, and their agents' keys. A content link already opened lasts at most 4 hours, as after a removal. The switch can't be turned on before S18 |

Access to a page's files ends when its content link does. Removing a person ends their session at once, but a link they already opened keeps working for up to 4 hours; it opens one version of a page they had already read.

## Not in v1

Single sign-on (SAML, OIDC), groups inside teams, access to a single page, assigning a decision to one person, mentions, email notices, several copies sharing people.
