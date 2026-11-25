# @openiql/adapter-opensearch

Transpiles a resolved OpenIQL query into an OpenSearch `_search` request
body (`{ body }` — `.keyword` addressing, `nested` changelog queries).

```ts
import { analyze } from '@openiql/core';
import { toOpenSearch } from '@openiql/adapter-opensearch';

const { resolved } = analyze('summary ~ login', schema);
const { body } = toOpenSearch(resolved, { tieBreaker: 'id' });
await client.search({ index: 'issues', body });
```

Docs & manual: https://github.com/yundo-main/openIQL · Apache-2.0
