# @openiql/adapter-sql

Transpiles a resolved OpenIQL query into `?`-placeholder SQL for the
`sqlite`, `mysql` and `ansi` dialects (`{ sql, params }`).

```ts
import { analyze } from '@openiql/core';
import { toSql } from '@openiql/adapter-sql';

const { resolved } = analyze('status = Open', schema);
const { sql, params } = toSql(resolved, { dialect: 'mysql' });
await conn.execute(sql, params);
```

Docs & manual: https://github.com/yundo-main/openIQL · Apache-2.0
