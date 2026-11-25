import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { os } from './helpers.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const enabled = dockerAvailable();
const IMAGE = 'opensearchproject/opensearch:2';
const INDEX = 'issues';

const MAPPING = {
  mappings: {
    properties: {
      id: { type: 'integer' },
      project_key: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      status: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      priority: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      assignee_id: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      summary: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      created_at: { type: 'date' },
      points: { type: 'float' },
      resolved: { type: 'boolean' },
      custom_fields: {
        type: 'object',
        properties: {
          story_points: { type: 'float' },
          team: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        },
      },
      changelogs: {
        type: 'nested',
        properties: {
          field: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          from_value: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          to_value: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        },
      },
    },
  },
};

const DOCS = [
  { id: 1, project_key: 'PROJ', status: 'Open', priority: 'High', assignee_id: 'usr_9921', summary: 'Login 100% broken', created_at: '2026-11-24T08:00:00Z', points: 3, resolved: false,
    custom_fields: { story_points: 5, team: 'core' },
    changelogs: [{ field: 'status', from_value: null, to_value: 'Open' }] },
  { id: 2, project_key: 'PROJ', status: 'Done', priority: 'Low', assignee_id: null, summary: 'Docs typo', created_at: '2026-11-10T08:00:00Z', points: 1, resolved: true,
    custom_fields: { story_points: 1 },
    changelogs: [
      { field: 'status', from_value: null, to_value: 'Open' },
      { field: 'status', from_value: 'Open', to_value: 'In Progress' },
      { field: 'status', from_value: 'In Progress', to_value: 'Done' },
    ] },
  { id: 3, project_key: 'PROJ', status: 'In Progress', priority: 'High', assignee_id: 'usr_1', summary: 'Login_page slow', created_at: '2026-11-20T08:00:00Z', points: null, resolved: false,
    custom_fields: { team: 'web' },
    changelogs: [
      { field: 'status', from_value: null, to_value: 'Open' },
      { field: 'status', from_value: 'Open', to_value: 'In Progress' },
    ] },
  { id: 4, project_key: 'OTHER', status: 'Open', priority: null, assignee_id: 'usr_9921', summary: 'Unrelated', created_at: '2026-11-25T01:00:00Z', points: 8, resolved: false,
    custom_fields: {},
    changelogs: [{ field: 'status', from_value: null, to_value: 'Open' }] },
  { id: 5, project_key: 'PROJ', status: 'Open', priority: 'Medium', assignee_id: '', summary: 'Empty-string assignee', created_at: '2026-11-01T00:00:00Z', points: 2, resolved: false,
    custom_fields: { team: '' },
    changelogs: [{ field: 'status', from_value: null, to_value: 'Open' }] },
];

describe.skipIf(!enabled)('OpenSearch semantics (real engine)', () => {
  let container = '';
  let base = '';

  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.json() as Promise<any>;
  };

  beforeAll(async () => {
    container = execFileSync(
      'docker',
      ['run', '-d', '--rm',
        '-e', 'discovery.type=single-node',
        '-e', 'DISABLE_SECURITY_PLUGIN=true',
        '-e', 'OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx512m',
        '-p', '127.0.0.1::9200', IMAGE],
      { encoding: 'utf8' },
    ).trim();
    const port = Number(
      execFileSync('docker', ['port', container, '9200/tcp'], { encoding: 'utf8' }).trim().split(':').pop(),
    );
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`${base}/_cluster/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (i > 150) throw new Error('OpenSearch did not start');
      await new Promise((r) => setTimeout(r, 1000));
    }
    await req('PUT', `/${INDEX}`, MAPPING);
    const ndjson = DOCS.flatMap((d) => [
      JSON.stringify({ index: { _index: INDEX, _id: String(d.id) } }),
      JSON.stringify(d),
    ]).join('\n') + '\n';
    const res = await fetch(`${base}/_bulk?refresh=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: ndjson,
    });
    if (!res.ok || (await res.json() as { errors: boolean }).errors) {
      throw new Error(`bulk index failed: ${await res.text()}`);
    }
  }, 300_000);

  afterAll(() => {
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  });

  const ids = async (q: string) => {
    const { body } = os(q, { tieBreaker: 'id', trackTotalHits: true });
    const r = await req('POST', `/${INDEX}/_search`, body);
    return (r.hits.hits as Array<{ _id: string }>).map((h) => Number(h._id));
  };

  it('comparison, logical and precedence', async () => {
    expect(await ids('project = PROJ AND status = Open')).toEqual([1, 5]);
    expect(await ids('status = Open OR status = Done AND priority = Low')).toEqual([1, 2, 4, 5]);
    expect(await ids('(priority = High OR assignee = currentUser()) AND project = PROJ')).toEqual([1, 3]);
  });
  it('!= and NOT match docs where the field is missing', async () => {
    expect(await ids('priority != High')).toEqual([2, 4, 5]);
    expect(await ids('NOT priority = High')).toEqual([2, 4, 5]);
    expect(await ids('status != Open')).toEqual([2, 3]);
  });
  it('~ is case-insensitive wildcard and escapes * ? \\', async () => {
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
  it('IS EMPTY covers missing fields and empty strings', async () => {
    expect(await ids('assignee IS EMPTY')).toEqual([2, 5]);
    expect(await ids('assignee IS NOT EMPTY')).toEqual([1, 3, 4]);
    expect(await ids('points IS EMPTY')).toEqual([3]);
    expect(await ids('cf.team IS EMPTY')).toEqual([2, 4, 5]);
    expect(await ids('cf.team IS NOT EMPTY')).toEqual([1, 3]);
  });
  it('dates, numbers, booleans', async () => {
    expect(await ids('created >= startOfDay(-5d)')).toEqual([1, 3, 4]);
    expect(await ids('created < "2026-11-10"')).toEqual([5]);
    expect(await ids('points >= 3')).toEqual([1, 4]);
    expect(await ids('resolved = true')).toEqual([2]);
  });
  it('custom fields', async () => {
    expect(await ids('cf.story_points > 2')).toEqual([1]);
    expect(await ids('cf.team = core')).toEqual([1]);
  });
  it('history operators on the nested changelogs field', async () => {
    expect(await ids('status WAS "In Progress"')).toEqual([2, 3]);
    expect(await ids('status CHANGED FROM "In Progress" TO Done')).toEqual([2]);
    expect(await ids('status CHANGED TO "In Progress"')).toEqual([2, 3]);
    expect(await ids('status CHANGED AND project = PROJ')).toEqual([1, 2, 3, 5]);
  });
  it('ORDER BY with tie breaker', async () => {
    // OpenSearch sorts missing values last regardless of direction (like MySQL).
    expect(await ids('ORDER BY priority DESC, created ASC')).toEqual([5, 2, 3, 1, 4]);
    expect(await ids('ORDER BY created DESC')).toEqual([4, 1, 3, 2, 5]);
  });
  it('injection attempts return no hits and the index stays intact', async () => {
    expect(await ids(`status = "' OR 1=1 --"`)).toEqual([]);
    const r = await req('GET', `/${INDEX}/_count`);
    expect(r.count).toBe(5);
  });
});
