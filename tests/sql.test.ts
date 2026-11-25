import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { analyze } from '@openiql/core';
import { toSql } from '@openiql/adapter-sql';
import { sql, schema, ctx } from './helpers.js';

describe('comparison operators (sqlite)', () => {
  it('= uses ? placeholders', () => {
    const out = sql('status = Open');
    expect(out.where).toBe('issues.status = ?');
    expect(out.params).toEqual(['Open']);
  });
  it('!= is a portable IS DISTINCT FROM (matches NULL)', () => {
    expect(sql('status != Done').where).toBe('(issues.status <> ? OR issues.status IS NULL)');
  });
  it('~ is LOWER() LIKE with escaped wildcards', () => {
    const out = sql('summary ~ "100%_x"');
    expect(out.where).toBe("LOWER(issues.summary) LIKE LOWER(?) ESCAPE '\\'");
    expect(out.params).toEqual(['%100\\%\\_x%']);
  });
  it('!~ matches NULL rows', () => {
    expect(sql('summary !~ "x"').where).toBe(
      "NOT COALESCE(LOWER(issues.summary) LIKE LOWER(?) ESCAPE '\\', FALSE)",
    );
  });
  it('ordering operators pass through', () => {
    expect(sql('points > 3').where).toBe('issues.points > ?');
    expect(sql('created <= "2026-01-01"').where).toBe('issues.created_at <= ?');
  });
  it('IN / NOT IN expand to positional placeholders', () => {
    expect(sql('priority IN (High, Critical)').where).toBe('issues.priority IN (?, ?)');
    expect(sql('priority NOT IN (High)').where).toBe(
      'NOT COALESCE(issues.priority IN (?), FALSE)',
    );
  });
  it('IS EMPTY / IS NOT EMPTY', () => {
    expect(sql('assignee IS EMPTY').where).toBe(
      "(issues.assignee_id IS NULL OR issues.assignee_id = '')",
    );
    expect(sql('points IS NOT EMPTY').where).toBe('NOT (issues.points IS NULL)');
  });
  it('history -> EXISTS changelog subquery', () => {
    const out = sql('status CHANGED FROM Open TO Done');
    expect(out.where).toBe(
      'EXISTS (SELECT 1 FROM issue_changelogs cl WHERE cl.issue_id = issues.id AND cl.field = ? AND cl.from_value = ? AND cl.to_value = ?)',
    );
    expect(out.params).toEqual(['status', 'Open', 'Done']);
  });
  it('spec example produces the full SELECT', () => {
    const out = sql(
      'project = PROJ AND (priority = High OR assignee = currentUser()) ORDER BY created DESC',
    );
    expect(out.sql).toBe(
      'SELECT issues.* FROM issues WHERE (issues.project_key = ? AND (issues.priority = ? OR issues.assignee_id = ?)) ORDER BY issues.created_at DESC',
    );
    expect(out.params).toEqual(['PROJ', 'High', 'usr_9921']);
  });
});

describe('dialects', () => {
  it('sqlite: custom fields use json_extract with an inlined path literal', () => {
    const out = sql('cf.story_points > 3');
    expect(out.where).toBe("json_extract(issues.custom_fields, '$.story_points') > ?");
    expect(out.params).toEqual([3]);
  });
  it('mysql: custom fields use JSON_UNQUOTE(JSON_EXTRACT) + CAST', () => {
    const out = sql('cf.story_points > 3', { dialect: 'mysql' });
    expect(out.where).toBe(
      "CAST(JSON_UNQUOTE(JSON_EXTRACT(issues.custom_fields, '$.story_points')) AS DECIMAL(65,30)) > ?",
    );
    const str = sql('cf.team = Platform', { dialect: 'mysql' });
    expect(str.where).toBe("JSON_UNQUOTE(JSON_EXTRACT(issues.custom_fields, '$.team')) = ?");
  });
  it('ansi: custom fields are rejected, core fields still work', () => {
    expect(() => sql('cf.team = a', { dialect: 'ansi' })).toThrow(/ansi/);
    expect(sql('status = a', { dialect: 'ansi' }).where).toBe('issues.status = ?');
  });
  it('rejects unsafe identifiers in options', () => {
    const { resolved } = analyze('status = a', schema, { context: ctx });
    expect(() => toSql(resolved, { table: 'x; DROP' })).toThrow(/Invalid table/);
    expect(() => toSql(resolved, { dialect: 'sqlite', tieBreaker: '1=1' })).toThrow(/Invalid/);
  });
});

// vitest's module runner does not resolve node:sqlite (added in Node 22.5),
// so load it through Node's own require, bypassing vite resolution.
const DatabaseSync = ((): typeof import('node:sqlite').DatabaseSync | undefined => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined; // node < 22.5
  }
})();

describe('sqlite end-to-end (node:sqlite)', () => {
  it.skipIf(!DatabaseSync)('generated SQL runs against a real SQLite database', () => {
    const db = new DatabaseSync!(':memory:');
    db.exec(`CREATE TABLE issues (
      id INTEGER PRIMARY KEY, project_key TEXT, status TEXT, priority TEXT,
      assignee_id TEXT, summary TEXT, created_at TEXT, points REAL, resolved INTEGER,
      custom_fields TEXT)`);
    db.exec(`CREATE TABLE issue_changelogs (
      issue_id INTEGER, field TEXT, from_value TEXT, to_value TEXT)`);
    const ins = db.prepare(
      'INSERT INTO issues VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    ins.run(1, 'PROJ', 'Open', 'High', 'usr_9921', 'login crash', '2026-11-20T00:00:00Z', 3, 0,
      JSON.stringify({ story_points: 5, team: 'Platform' }));
    ins.run(2, 'PROJ', 'Done', 'Low', null, 'UI glitch', '2026-11-21T00:00:00Z', 1, 1,
      JSON.stringify({ team: 'Design' }));
    ins.run(3, 'OPS', 'Open', 'Critical', 'usr_5555', 'db down', '2026-11-22T00:00:00Z', 8, 0, '{}');
    const ch = db.prepare('INSERT INTO issue_changelogs VALUES (?, ?, ?, ?)');
    ch.run(1, 'status', null, 'Open');      // created as Open
    ch.run(2, 'status', 'Open', 'Done');
    ch.run(3, 'status', null, 'Open');

    const ids = (q: string) =>
      (db.prepare(sql(q).sql).all(...sql(q).params as never[]) as Array<{ id: number }>).map(
        (r) => r.id,
      );

    expect(ids('status = Open')).toEqual([1, 3]);
    expect(ids('status != Done')).toEqual([1, 3]);      // includes nothing missing here
    expect(ids('assignee IS EMPTY')).toEqual([2]);
    expect(ids('summary ~ "crash"')).toEqual([1]);
    expect(ids('summary ~ "CRASH"')).toEqual([1]);      // case-insensitive
    expect(ids('points > 2')).toEqual([1, 3]);
    expect(ids('priority IN (High, Critical)')).toEqual([1, 3]);
    expect(ids('cf.team = Platform')).toEqual([1]);
    expect(ids('cf.story_points > 3')).toEqual([1]);
    expect(ids('status WAS Done')).toEqual([2]);
    expect(ids('status WAS Open')).toEqual([1, 2, 3]);  // from NULL->Open or Open->Done
    expect(ids('status CHANGED FROM Open TO Done')).toEqual([2]);
    expect(ids('project = PROJ AND NOT status = Done')).toEqual([1]);
    expect(ids('assignee != usr_9921')).toEqual([2, 3]); // NULL row matches

    const { sql: text, params } = sql('status = Open ORDER BY created DESC');
    const rows = db.prepare(text).all(...params as never[]) as Array<{ id: number }>;
    expect(rows.map((r) => r.id)).toEqual([3, 1]);
    db.close();
  });
});
