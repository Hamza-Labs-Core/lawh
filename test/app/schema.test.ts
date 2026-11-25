import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

// integrity.py tests the rules on SQLite. This proves that D1 itself accepts the schema and runs its triggers:
// the migration splitter, json_each in a trigger, CASE in a trigger, foreign keys, and the Arabic search index.
const run = (...statements: string[]) => env.DB.batch(statements.map((s) => env.DB.prepare(s)));
const SOON = Date.now() + 600_000;

beforeEach(async () => {
  await run(
    "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1),('p2','two','Two','اثنان',1)",
    "INSERT INTO members(id,name,role,created_at) VALUES('o','Owner','owner',1)",
    `INSERT INTO access_links(token_sha256,kind,member_id,created_at,expires_at) VALUES('l','owner','o',1,${SOON})`,
    "INSERT INTO passkeys(credential_id,member_id,public_key,sign_count,label,created_at,link_id) VALUES('c','o',x'00',0,'n',1,'l')",
    `INSERT INTO sessions(token_sha256,member_id,label,created_at,last_seen_at,expires_at,passkey_id) VALUES('s','o','l',1,1,${SOON},'c')`,
    "INSERT INTO agents(id,member_id,name,created_at) VALUES('a','o','bot',1)",
    `INSERT INTO agent_connects(id,code_hmac,secret_hmac,client,machine,created_at,expires_at) VALUES('k','code','mac','claude','laptop',1,${SOON})`,
  );
});

describe('schema on D1', () => {
  it('owner setup marks the owner as joined', async () => {
    expect(await env.DB.prepare("SELECT joined_at FROM members WHERE id='o'").first('joined_at')).toBeGreaterThan(0);
  });

  it('answering a connect request adds the key and its projects', async () => {
    await run(`UPDATE agent_connects SET answered_at=7,member_id='o',approver_session='s',agent_id='a',scopes_json='[]',
      all_projects=0,projects_json='["p1","p2"]',key_expires_at=99 WHERE id='k'`);
    expect(await env.DB.prepare("SELECT agent_id,secret_hmac,label FROM agent_keys WHERE id='k'").first())
      .toEqual({ agent_id: 'a', secret_hmac: 'mac', label: 'laptop' });
    const { results } = await env.DB.prepare("SELECT project_id FROM agent_key_projects WHERE key_id='k' ORDER BY 1").all();
    expect(results).toEqual([{ project_id: 'p1' }, { project_id: 'p2' }]);
  });

  it('a bad project in that list adds nothing at all', async () => {
    await expect(run(`UPDATE agent_connects SET answered_at=7,member_id='o',approver_session='s',agent_id='a',scopes_json='[]',
      all_projects=0,projects_json='["p1","nope"]',key_expires_at=99 WHERE id='k'`)).rejects.toThrow(/FOREIGN KEY/);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM agent_keys').first('n')).toBe(0);
  });

  it('an answer is checked, decides and moves the decision', async () => {
    await run(
      "INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('g','p1','s','T','a',1,1)",
      "INSERT INTO decisions(id,page_id,project_id,key,position,created_at,updated_at) VALUES('d','g','p1','k',0,1,1)",
      "INSERT INTO decision_revisions VALUES('d',1,'Q','','[]',NULL,1,1)",
    );
    const answer = (seq: number, decides: number) => run(
      `INSERT INTO decision_answers(decision_id,seq,revision,option_id,answered_at,member_id,needed,decides) VALUES('d',${seq},1,'x',5,'o',1,${decides})`);
    await expect(answer(1, 0)).rejects.toThrow(/answer conflict/);
    await expect(answer(2, 1)).rejects.toThrow(/answer conflict/);
    await answer(1, 1);
    expect(await env.DB.prepare('SELECT status,answer_seq,decided_seq FROM decisions').first())
      .toEqual({ status: 'answered', answer_seq: 1, decided_seq: 1 });
    await expect(run("UPDATE decision_answers SET notes='x'")).rejects.toThrow(/append only/);
  });

  it('agreement needs the teams switch, and turning teams off resets it', async () => {
    const need = () => env.DB.prepare("SELECT answers_needed FROM projects WHERE id='p1'").first('answers_needed');
    await expect(run("UPDATE projects SET answers_needed=2 WHERE id='p1'")).rejects.toThrow(/agreement needs teams/);
    await run("INSERT INTO settings(key,value_json,updated_at) VALUES('teams','true',1)", "UPDATE projects SET answers_needed=2 WHERE id='p1'");
    expect(await need()).toBe(2);
    await run("UPDATE settings SET value_json='false' WHERE key='teams'");
    expect(await need()).toBe(1);
  });

  it('searches Arabic and English by prefix', async () => {
    await run(
      "INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('g','p1','s','T','a',1,1)",
      "INSERT INTO pages_fts_map(page_id) VALUES('g')",
      "INSERT INTO pages_fts(rowid,scope,title,summary,tags,body) SELECT rowid,'p70','تخزين الصور','','','Café storage' FROM pages_fts_map",
    );
    for (const word of ['تخز*', 'cafe', 'stor*']) {
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH ?').bind(word).first('n'), word).toBe(1);
    }
  });
});
