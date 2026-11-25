# OpenIQL

Open Issue Query Language: parse `project = PROJ AND priority IN (High, Critical) ORDER BY created DESC`
into a safe AST and transpile it to parameterised SQL.

```ts
import { analyze, createSchema } from '@openiql/core';
import { toPostgres } from '@openiql/adapter-postgres';
import { toOpenSearch } from '@openiql/adapter-opensearch';

const schema = createSchema({
  fields: { project: { type: 'STRING', column: 'project_key' }, priority: { type: 'STRING' } },
  customFields: { story_points: { type: 'NUMBER' } },
});
const { resolved } = analyze('project = PROJ AND cf.story_points > 3', schema, { context: { userId: 'u1' } });
const { sql, params } = toPostgres(resolved); // run with pg: client.query(sql, params)
const { body } = toOpenSearch(resolved);      // run with opensearch: client.search({ index, body })
```

- Spec: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [spec/grammar.ebnf](spec/grammar.ebnf)
- Legal review notes: [docs/LEGAL-NOTES.md](docs/LEGAL-NOTES.md)
- `npm test` (the PostgreSQL integration test needs Docker and is skipped without it)
