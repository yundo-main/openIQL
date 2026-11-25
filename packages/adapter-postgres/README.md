# @openiql/adapter-postgres

Transpiles a resolved OpenIQL query into parameterised PostgreSQL
(`{ sql, params }` — every user value is a `$n` bind parameter).

```ts
import { analyze } from '@openiql/core';
import { toPostgres } from '@openiql/adapter-postgres';

const { resolved } = analyze('status = Open AND assignee = currentUser()', schema, { context });
const { sql, params } = toPostgres(resolved, { tieBreaker: 'id' });
await client.query(sql, params);
```

Docs & manual: https://github.com/yundo-main/openIQL · Apache-2.0
