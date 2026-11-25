export type Switch = 'instance' | 'teams' | 'webhooks' | 'live';

/** A switch is on only when its row says exactly `true`. No row, or any other value, is off. */
export async function isOn(db: D1Database, name: Switch): Promise<boolean> {
  const row = await db.prepare('SELECT value_json FROM settings WHERE key = ?').bind(name).first<{ value_json: string }>();
  return row?.value_json === 'true';
}
