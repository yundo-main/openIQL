import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { sql } from './helpers.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const enabled = dockerAvailable();
const IMAGE = 'mariadb:11';

describe.skipIf(!enabled)('MySQL dialect semantics (real MariaDB)', () => {
  let container = '';
  let conn: mysql.Connection;

  beforeAll(async () => {
    container = execFileSync(
      'docker',
      ['run', '-d', '--rm', '-e', 'MARIADB_ROOT_PASSWORD=pw', '-e', 'MARIADB_DATABASE=openiql',
        '-p', '127.0.0.1::3306', IMAGE],
      { encoding: 'utf8' },
    ).trim();
    const port = Number(
      execFileSync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' }).trim().split(':').pop(),
    );
    for (let i = 0; ; i++) {
      try {
        conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'pw', database: 'openiql' });
        await conn.query('SELECT 1');
        break;
      } catch (e) {
        await conn?.end().catch(() => {});
        if (i > 90) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const ddl = readFileSync(new URL('./fixtures/schema.mysql.sql', import.meta.url), 'utf8');
    for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
      await conn.query(stmt);
    }
  }, 180_000);

  afterAll(async () => {
    await conn?.end().catch(() => {});
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  });

  const ids = async (q: string) => {
    const { sql: text, params } = sql(q, { dialect: 'mysql', tieBreaker: 'id' });
    // mysql2's execute() rejects param arrays when the statement has no placeholders.
    const [rows] = params.length > 0
      ? await conn.execute(text, params as never[])
      : await conn.query(text);
    return (rows as Array<{ id: number }>).map((r) => r.id);
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
    expect(await ids('summary ~ "n_p"')).toEqual([3]);
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
    expect(await ids('created >= startOfDay(-5d)')).toEqual([1, 3, 4]);
    expect(await ids('created < "2026-11-10"')).toEqual([5]);
    expect(await ids('points >= 3')).toEqual([1, 4]);
    expect(await ids('resolved = true')).toEqual([2]);
  });
  it('custom fields (JSON_UNQUOTE + CAST)', async () => {
    expect(await ids('cf.story_points > 2')).toEqual([1]);
    expect(await ids('cf.team = core')).toEqual([1]);
  });
  it('history operators', async () => {
    expect(await ids('status WAS "In Progress"')).toEqual([2, 3]);
    expect(await ids('status CHANGED FROM "In Progress" TO Done')).toEqual([2]);
    expect(await ids('status CHANGED TO "In Progress"')).toEqual([2, 3]);
    expect(await ids('status CHANGED AND project = PROJ')).toEqual([1, 2, 3, 5]);
  });
  it('ORDER BY with tie breaker', async () => {
    // MySQL sorts NULLs last on DESC (Postgres sorts them first).
    expect(await ids('ORDER BY priority DESC, created ASC')).toEqual([5, 2, 3, 1, 4]);
    expect(await ids('ORDER BY created DESC')).toEqual([4, 1, 3, 2, 5]);
  });
  it('injection attempts return no rows and leave data intact', async () => {
    expect(await ids(`status = "' OR 1=1 --"`)).toEqual([]);
    const [rows] = await conn.query('SELECT count(*) AS n FROM issues');
    expect(Number((rows as Array<{ n: number | bigint }>)[0]?.n)).toBe(5);
  });
});
