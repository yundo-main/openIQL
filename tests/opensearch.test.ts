import { describe, expect, it } from 'vitest';
import { analyze } from '@openiql/core';
import { toOpenSearch } from '@openiql/adapter-opensearch';
import { os, schema, ctx } from './helpers.js';

describe('comparison operators', () => {
  it('= on a STRING field uses the .keyword sub-field', () => {
    expect(os('status = Open').query).toEqual({ term: { 'status.keyword': 'Open' } });
  });
  it('= on non-string fields uses the field itself', () => {
    expect(os('points = 3').query).toEqual({ term: { points: 3 } });
    expect(os('resolved = true').query).toEqual({ term: { resolved: true } });
  });
  it('!= is a must_not so missing-field documents match', () => {
    expect(os('status != Done').query).toEqual({
      bool: { must_not: [{ term: { 'status.keyword': 'Done' } }] },
    });
  });
  it('~ is a case-insensitive wildcard substring query', () => {
    expect(os('summary ~ "crash"').query).toEqual({
      wildcard: { 'summary.keyword': { value: '*crash*', case_insensitive: true } },
    });
  });
  it('~ escapes wildcard metacharacters in user input', () => {
    expect(os('summary ~ "a*b?c\\\\d"').query).toEqual({
      wildcard: { 'summary.keyword': { value: '*a\\*b\\?c\\\\d*', case_insensitive: true } },
    });
  });
  it('!~ wraps the wildcard in must_not', () => {
    expect(os('summary !~ "crash"').query).toEqual({
      bool: {
        must_not: [
          { wildcard: { 'summary.keyword': { value: '*crash*', case_insensitive: true } } },
        ],
      },
    });
  });
  it.each([
    ['points > 3', 'gt'],
    ['points >= 3', 'gte'],
    ['points < 3', 'lt'],
    ['points <= 3', 'lte'],
  ])('%s -> range %s', (q, op) => {
    expect(os(q).query).toEqual({ range: { points: { [op]: 3 } } });
  });
  it('date range values are ISO strings', () => {
    expect(os('created > startOfDay(-1d)').query).toEqual({
      range: { created_at: { gt: '2026-11-24T00:00:00.000Z' } },
    });
  });
});

describe('list / null / logical / history', () => {
  it('IN -> terms, NOT IN -> must_not terms', () => {
    expect(os('priority IN (High, Critical)').query).toEqual({
      terms: { 'priority.keyword': ['High', 'Critical'] },
    });
    expect(os('priority NOT IN (High)').query).toEqual({
      bool: { must_not: [{ terms: { 'priority.keyword': ['High'] } }] },
    });
  });
  it('IS EMPTY on a STRING field matches missing or empty', () => {
    expect(os('assignee IS EMPTY').query).toEqual({
      bool: {
        should: [
          { bool: { must_not: [{ exists: { field: 'assignee_id' } }] } },
          { term: { 'assignee_id.keyword': '' } },
        ],
        minimum_should_match: 1,
      },
    });
  });
  it('IS EMPTY on a non-string field is must_not exists', () => {
    expect(os('points IS EMPTY').query).toEqual({
      bool: { must_not: [{ exists: { field: 'points' } }] },
    });
  });
  it('IS NOT EMPTY on a STRING field requires exists and non-empty', () => {
    expect(os('assignee IS NOT EMPTY').query).toEqual({
      bool: {
        must: [
          { exists: { field: 'assignee_id' } },
          { bool: { must_not: [{ term: { 'assignee_id.keyword': '' } }] } },
        ],
      },
    });
  });
  it('AND -> must, OR -> should, NOT -> must_not', () => {
    expect(os('status = a AND points = 1').query).toEqual({
      bool: { must: [{ term: { 'status.keyword': 'a' } }, { term: { points: 1 } }] },
    });
    expect(os('status = a OR points = 1').query).toEqual({
      bool: {
        should: [{ term: { 'status.keyword': 'a' } }, { term: { points: 1 } }],
        minimum_should_match: 1,
      },
    });
    expect(os('NOT status = a').query).toEqual({
      bool: { must_not: [{ term: { 'status.keyword': 'a' } }] },
    });
  });
  it('WAS -> nested query on from_value OR to_value', () => {
    expect(os('status WAS Open').query).toEqual({
      nested: {
        path: 'changelogs',
        query: {
          bool: {
            must: [
              { term: { 'changelogs.field.keyword': 'status' } },
              {
                bool: {
                  should: [
                    { term: { 'changelogs.from_value.keyword': 'Open' } },
                    { term: { 'changelogs.to_value.keyword': 'Open' } },
                  ],
                  minimum_should_match: 1,
                },
              },
            ],
          },
        },
      },
    });
  });
  it('CHANGED FROM a TO b -> nested query requiring both', () => {
    expect(os('status CHANGED FROM Open TO Done').query).toEqual({
      nested: {
        path: 'changelogs',
        query: {
          bool: {
            must: [
              { term: { 'changelogs.field.keyword': 'status' } },
              { term: { 'changelogs.from_value.keyword': 'Open' } },
              { term: { 'changelogs.to_value.keyword': 'Done' } },
            ],
          },
        },
      },
    });
  });
});

describe('query body / order by / options', () => {
  it('empty query produces match_all and no sort', () => {
    const out = os('');
    expect(out.query).toEqual({ match_all: {} });
    expect(out.sort).toBeNull();
    expect(out.body).toEqual({ query: { match_all: {} } });
  });
  it('ORDER BY uses the keyword sub-field for strings', () => {
    expect(os('ORDER BY status DESC, created ASC').sort).toEqual([
      { 'status.keyword': { order: 'desc' } },
      { created_at: { order: 'asc' } },
    ]);
  });
  it('generates the expected body for the spec example', () => {
    const out = os(
      'project = PROJ AND (priority = High OR assignee = currentUser()) ORDER BY created DESC',
    );
    expect(out.body).toEqual({
      query: {
        bool: {
          must: [
            { term: { 'project_key.keyword': 'PROJ' } },
            {
              bool: {
                should: [
                  { term: { 'priority.keyword': 'High' } },
                  { term: { 'assignee_id.keyword': 'usr_9921' } },
                ],
                minimum_should_match: 1,
              },
            },
          ],
        },
      },
      sort: [{ created_at: { order: 'desc' } }],
    });
  });
  it('custom fields are addressed under custom_fields', () => {
    expect(os('cf.story_points > 3').query).toEqual({
      range: { 'custom_fields.story_points': { gt: 3 } },
    });
    expect(os('cf.team = Platform').query).toEqual({
      term: { 'custom_fields.team.keyword': 'Platform' },
    });
  });
  it('tieBreaker and trackTotalHits are emitted', () => {
    const out = os('status = a ORDER BY created DESC', {
      tieBreaker: 'id',
      trackTotalHits: true,
    });
    expect(out.sort).toEqual([
      { created_at: { order: 'desc' } },
      { id: { order: 'asc' } },
    ]);
    expect(out.body.track_total_hits).toBe(true);
  });
  it("keywordSuffix '' disables sub-field addressing", () => {
    expect(os('status = Open', { keywordSuffix: '' }).query).toEqual({
      term: { status: 'Open' } });
  });
  it('rejects unsafe paths in adapter options', () => {
    const { resolved } = analyze('status = a', schema, { context: ctx });
    expect(() => toOpenSearch(resolved, { customFieldsPath: 'a b' })).toThrow(/Invalid/);
    expect(() => toOpenSearch(resolved, { keywordSuffix: '.x;y' })).toThrow(/Invalid/);
    expect(() => toOpenSearch(resolved, { changelog: { path: 'c..d' } })).toThrow(/Invalid/);
    expect(() => toOpenSearch(resolved, { tieBreaker: 'id, (hack)' })).toThrow(/Invalid/);
  });
});
