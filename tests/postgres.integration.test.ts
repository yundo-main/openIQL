import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { pg as compile } from './helpers.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const enabled = dockerAvailable();
const IMAGE = 'postgres:16-alpine';

describe.skipIf(!enabled)('PostgreSQL semantics (real database)', () => {
  let container = '';
  let client: pg.Client;

  beforeAll(async () => {
    container = execFileSync(
      'docker',
      ['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=pw', '-p', '127.0.0.1::5432', IMAGE],
      { encoding: 'utf8' },
    ).trim();
    const port = Number(
      execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop(),
    );
    for (let i = 0; ; i++) {
      try {
        client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: 'postgres' });
        await client.connect();
        await client.query('SELECT 1');
        break;
      } catch (e) {
        await client?.end().catch(() => {});
        if (i > 60) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await client.query(readFileSync(new URL('./fixtures/schema.sql', import.meta.url), 'utf8'));
  }, 90_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  });

  const ids = async (q: string) => {
    const { sql, params } = compile(q, { tieBreaker: 'id' });
    const r = await client.query(sql, params);
    return r.rows.map((x) => x.id as number);
  };

  it('comparison, logical and precedence', async () => {
    expect(await ids('project = PROJ AND status = Open')).toEqual([1, 5]);
    expect(await ids('status = Open OR status = Done AND priority = Low')).toEqual([1, 2, 4, 5]);
    expect(await ids('(priority = High OR assignee = currentUser()) AND project = PROJ')).toEqual([1, 3]);
  });
  it('!= and NOT treat NULL as a non-match of the positive predicate', async () => {
    expect(await ids('priority != High')).toEqual([2, 4, 5]);
    expect(await ids('NOT priority = High')).toEqual([2, 4, 5]);
  });
  it('~ is case-insensitive and escapes wildcards', async () => {
    expect(await ids('summary ~ login')).toEqual([1, 3]);
    expect(await ids('summary ~ "100%"')).toEqual([1]);
    expect(await ids('summary ~ "n_p"')).toEqual([3]); // literal underscore only
    expect(await ids('summary !~ login')).toEqual([2, 4, 5]);
  });
  it('IN / NOT IN', async () => {
    expect(await ids('status IN (Open, Done)')).toEqual([1, 2, 4, 5]);
    expect(await ids('status NOT IN (Open, Done)')).toEqual([3]);
    expect(await ids('priority NOT IN (High)')).toEqual([2, 4, 5]);
  });
  it('IS EMPTY covers NULL and empty strings', async () => {
    expect(await ids('assignee IS EMPTY')).toEqual([2, 5]);
    expect(await ids('assignee IS NOT EMPTY')).toEqual([1, 3, 4]);
    expect(await ids('points IS EMPTY')).toEqual([3]);
    expect(await ids('cf.team IS EMPTY')).toEqual([2, 4, 5]);
  });
  it('dates, numbers, booleans', async () => {
    // helpers.ts pins now = 2026-11-25T10:30Z, so startOfDay(-5d) = 2026-11-20T00:00Z
    expect(await ids('created >= startOfDay(-5d)')).toEqual([1, 3, 4]);
    expect(await ids('created < "2026-11-10"')).toEqual([5]);
    expect(await ids('points >= 3')).toEqual([1, 4]);
    expect(await ids('resolved = true')).toEqual([2]);
  });
  it('custom fields (numeric cast and text)', async () => {
    expect(await ids('cf.story_points > 2')).toEqual([1]);
    expect(await ids('cf.team = core')).toEqual([1]);
    expect(await ids('ORDER BY cf.story_points DESC')).toEqual([3, 4, 5, 1, 2]); // NULLs first in DESC
  });
  it('history operators', async () => {
    expect(await ids('status WAS "In Progress"')).toEqual([2, 3]);
    expect(await ids('status CHANGED FROM "In Progress" TO Done')).toEqual([2]);
    expect(await ids('status CHANGED TO "In Progress"')).toEqual([2, 3]);
    expect(await ids('status CHANGED AND project = PROJ')).toEqual([1, 2, 3, 5]);
  });
  it('ORDER BY with tie breaker', async () => {
    expect(await ids('ORDER BY priority DESC, created ASC')).toEqual([4, 5, 2, 3, 1]);
    expect(await ids('ORDER BY created DESC')).toEqual([4, 1, 3, 2, 5]);
  });
  it('injection attempts return no rows and leave data intact', async () => {
    expect(await ids(`status = "' OR 1=1 --"`)).toEqual([]);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM issues');
    expect(rows[0].n).toBe(5);
  });
});
