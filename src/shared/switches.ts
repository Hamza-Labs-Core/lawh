export type Switch = 'instance' | 'teams' | 'webhooks' | 'live';

/** Everyone but the owner needs both. */
export async function membersAllowed(db: D1Database): Promise<boolean> {
  const { results } = await db.prepare("SELECT key FROM settings WHERE key IN ('instance','teams') AND value_json = 'true'").all();
  return results.length === 2;
}

/** A switch is on only when its row says exactly `true`. No row, or any other value, is off. */
export async function isOn(db: D1Database, name: Switch): Promise<boolean> {
  const row = await db.prepare('SELECT value_json FROM settings WHERE key = ?').bind(name).first<{ value_json: string }>();
  return row?.value_json === 'true';
}
