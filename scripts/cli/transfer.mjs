// Ownership transfer (`pnpm lawh owner transfer <member> [--local]`).
// Moves ownership in one atomic D1 command to a joined member, revoking old owner agent keys,
// disambiguating colliding agent names, removing both from teams, and canceling unused links/invites.
const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;

function chooseUniqueAgentName(baseName, agentId, takenNames) {
  if (!takenNames.has(baseName)) {
    takenNames.add(baseName);
    return baseName;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const tag = attempt === 0 ? agentId : `${agentId}-${attempt + 1}`;
    const suffix = ` (${tag})`;
    const maxPrefix = Math.max(0, 60 - suffix.length);
    const candidate = maxPrefix > 0 ? `${[...baseName].slice(0, maxPrefix).join('')}${suffix}` : tag.slice(0, 60);
    if (!takenNames.has(candidate)) {
      takenNames.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not choose a unique name for agent ${agentId}.`);
}

export async function runOwnerTransfer({ targetArg, sql, prompt, log = console.log, now = () => Date.now() }) {
  const query = (statement) => {
    const res = sql(statement);
    return res?.[0]?.results ?? [];
  };

  const [owner] = query("SELECT id, name, joined_at FROM members WHERE role = 'owner' AND removed_at IS NULL");
  if (!owner) throw new Error('No active owner found.');

  const allMembers = query(
    "SELECT id, name, role, joined_at, removed_at FROM members WHERE removed_at IS NULL ORDER BY name, id",
  );
  const byId = allMembers.filter((m) => m.id === targetArg);
  const byName = byId.length > 0 ? byId : allMembers.filter((m) => m.name === targetArg);
  if (byName.length === 0) throw new Error(`Member "${targetArg}" was not found.`);
  if (byName.length > 1) {
    const list = byName.map((m) => `  ${m.id} (${m.name})`).join('\n');
    throw new Error(`Multiple members match "${targetArg}". Pass the member id instead:\n${list}`);
  }
  const target = byName[0];
  if (target.role === 'owner') throw new Error(`"${target.name}" (${target.id}) is already the owner.`);
  if (target.joined_at === null) throw new Error(`"${target.name}" (${target.id}) has not joined yet.`);

  const oldAgents = query(`SELECT id, name FROM agents WHERE member_id = ${sqlText(owner.id)} ORDER BY name, id`);
  const targetAgents = query(`SELECT id, name FROM agents WHERE member_id = ${sqlText(target.id)}`);
  const taken = new Set(targetAgents.map((a) => a.name));
  const agentMoves = oldAgents.map((a) => ({
    id: a.id,
    oldName: a.name,
    newName: chooseUniqueAgentName(a.name, a.id, taken),
  }));

  log('');
  log(`Transfer ownership from "${owner.name}" (${owner.id}) to "${target.name}" (${target.id})?`);
  log('');
  log('This will happen in one transaction:');
  log(`  - "${target.name}" becomes the owner; "${owner.name}" becomes a regular member.`);
  log('  - Both people leave every team.');
  log('  - Every unused invite, reset, or owner link made for or by either person is deleted.');
  log('  - People invited by those deleted links are canceled.');
  if (agentMoves.length === 0) {
    log(`  - "${owner.name}" has no agents to move.`);
  } else {
    log(`  - ${agentMoves.length} agent(s) belonging to "${owner.name}" move to "${target.name}" and lose all their keys (new keys must be created):`);
    for (const m of agentMoves) {
      log(m.newName === m.oldName ? `      * ${m.oldName} (${m.id})` : `      * ${m.oldName} -> ${m.newName} (${m.id})`);
    }
  }
  log('');

  const answer = (await prompt('Type "yes" to transfer ownership: ')).trim().toLowerCase();
  if (answer !== 'yes') {
    throw new Error('Cancelled. Ownership was not transferred.');
  }

  const ts = now();
  const statements = [
    // Verify neither person changed role or was removed before committing.
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM members WHERE id = ${sqlText(owner.id)} AND role = 'owner' AND removed_at IS NULL)
      AND EXISTS (SELECT 1 FROM members WHERE id = ${sqlText(target.id)} AND role = 'member' AND joined_at IS NOT NULL AND removed_at IS NULL)
      THEN 1 ELSE json('conflict') END;`,
    // Triggers on UPDATE OF role remove both from teams, delete unused links made for/by either, and cancel pending invites.
    `UPDATE members SET role = 'member' WHERE id = ${sqlText(owner.id)} AND role = 'owner';`,
    `UPDATE members SET role = 'owner' WHERE id = ${sqlText(target.id)} AND role = 'member' AND joined_at IS NOT NULL AND removed_at IS NULL;`,
    // Move all of the old owner's agents to the new owner; `agents_moved` trigger revokes all their keys atomically.
    ...agentMoves.map((m) =>
      `UPDATE agents SET name = ${sqlText(m.newName)}, member_id = ${sqlText(target.id)} WHERE id = ${sqlText(m.id)} AND member_id = ${sqlText(owner.id)};`,
    ),
    `INSERT INTO audit(at, actor_type, action, subject_id) VALUES(${ts}, 'command', 'owner.transfer', ${sqlText(target.id)});`,
  ];

  sql(statements.join('\n'));
  log(`Ownership transferred to "${target.name}" (${target.id}).`);
  return { from: owner, to: target, movedAgents: agentMoves };
}
