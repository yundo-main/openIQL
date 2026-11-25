# OpenIQL API 레퍼런스

v0.1 공개 API. 모든 진입점은 `ResolvedQuery`를 생산하고, 각 어댑터가 이를 실행 쿼리로 변환합니다.

```text
?q= text ──parse──▶ QueryAST ──resolve──▶ ResolvedQuery ──┬─ toPostgres() ─▶ { sql, params }
?filter= JSON ────────────────resolve───▶                 ├─ toSql() ──────▶ { sql, params }
                                                          └─ toOpenSearch() ▶ { body }
analyze() = parse + resolve,  analyzeRequest() = ?q=/?filter= 디스패치
```

---

## `@openiql/core`

### `analyze(source, schema, options?) → { ast, resolved }`

텍스트 쿼리를 파싱·검증·함수 평가까지 한 번에 수행합니다.

- `source: string` — OpenIQL 텍스트 쿼리 (`spec/grammar.ebnf`)
- `options.context?: { userId?: string; now?: Date }` — `currentUser()` 바인딩 값과 시간 함수 기준 시각
- `options.functions?: Record<string, IQLFunction>` — 커스텀 함수(내장 함수보다 우선, 이름 대소문자 무시)
- `options.limits?: Partial<Limits>` — `maxQueryBytes`(2048) `maxDepth`(10) `maxInListSize`(100)
- `options.maxAstDepth`(1000) / `maxOrderByItems`(10) / `maxInListSize`(100) — JSON AST 방어

```ts
const { ast, resolved } = analyze('status = Open AND assignee = currentUser()', schema, {
  context: { userId: 'usr_9921' },
});
```

### `analyzeRequest(params, schema, options?) → { source, ast, resolved }`

HTTP 검색 진입점 (`?q=` / `?filter=`). `q`는 문자열이어야 하고 `filter`는 JSON AST 객체 또는 JSON 문자열.
둘 다 주면 `ValidationError`, 둘 다 없으면 무조건 검색(`source: null`).

### `parse(source, limits?) → QueryAST`

파싱만 수행. 실패 시 `IQLSyntaxError` (`error.message`, `location {offset,line,column}`, `expected[]`).

### `resolve(ast, schema, options?) → ResolvedQuery`

AST(파서 산출물 또는 **신뢰할 수 없는** `?filter=` JSON)를 스키마로 검증하고 함수를 평가합니다.
스키마 미등록 필드 → `UnknownFieldError`, 타입·연산자 위반 → `ValidationError`.

### `print(ast) → string`

AST를 OpenIQL 텍스트로 직렬화합니다 (`parse(print(ast)) === ast`, UI 필터 → 검색창 표시용).

### `createSchema(config) → Schema`

```ts
const schema = createSchema({
  fields: {                              // 고정 코어 필드 화이트리스트
    status: { type: 'STRING' },          // column 생략 시 필드명 = 컬럼명
    assignee: { type: 'STRING', column: 'assignee_id' },
    created: { type: 'DATE', column: 'created_at' },
    points: { type: 'NUMBER' },
  },
  customFields: { story_points: { type: 'NUMBER' } },  // `cf.story_points`로 접근
  customFieldPrefix: 'cf',               // 기본값 'cf'
});
```

타입: `'STRING' | 'NUMBER' | 'BOOLEAN' | 'DATE'`. `~`는 STRING만, `< > <= >=`는 NUMBER·DATE만 허용합니다.
필드명·컬럼명·커스텀 키는 전부 `^[A-Za-z_]\w*$` 검증을 통과해야 합니다.

### 오류 타입

| 클래스 | code | 발생 |
|---|---|---|
| `IQLSyntaxError` | `SyntaxError` | 파싱 실패 — `location`, `expected: string[]` |
| `UnknownFieldError` | `UnknownFieldError` | 미등록 필드 — `field` |
| `LimitExceededError` | `LimitExceededError` | DoS 임계치 — `limit`, `max` |
| `ValidationError` | `ValidationError` | 타입 불일치, 인자 오류, `q`+`filter` 동시 지정 등 |

모든 오류는 `OpenIQLError`를 상속하며 `.toJSON()`으로 `{"error","message","location"?}` 직렬화됩니다.

---

## `@openiql/adapter-postgres` — `toPostgres(resolved, options?) → PostgresQuery`

`{ sql, where, orderBy, params }` — `sql`은 `SELECT <select> FROM <table> [WHERE] [ORDER BY]`,
모든 사용자 값은 `$n` 바인딩 파라미터입니다 (`client.query(sql, params)`로 실행).

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `table` | `'issues'` | 이슈 테이블 (스키마 수식 가능) |
| `idColumn` | `'id'` | changelog 조인용 PK |
| `customFieldsColumn` | `'custom_fields'` | JSONB 컬럼 |
| `select` | `<table>.*` | SELECT 목록 — **신뢰된 문자열만** |
| `paramOffset` | `0` | 호출자가 이미 사용한 `$n` 개수 |
| `tieBreaker` | — | 결정적 페이지네이션용 정렬 꼬리 컬럼 |
| `changelog.*` | `issue_changelogs`, `issue_id`, `field`, `from_value`, `to_value` | 이력 테이블 매핑 |

`!=`는 `IS DISTINCT FROM`으로 NULL 행을 포함하고, `~`는 `ILIKE`(와일드카드 이스케이프)입니다.
테이블/컬럼 옵션은 식별자 패턴 검증을 통과해야 합니다.

## `@openiql/adapter-sql` — `toSql(resolved, options?) → SqlQuery`

`{ sql, where, orderBy, params }` — `?` 플레이스홀더 버전. `PostgresQuery`와 같은 형태입니다.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `dialect` | `'sqlite'` | `'sqlite' \| 'mysql' \| 'ansi'` |
| 나머지 | postgres와 동일 (`paramOffset` 없음) | |

방언별 차이: `!=`는 `(col <> ? OR col IS NULL)`, `~`는 `LOWER(col) LIKE LOWER(?) ESCAPE '\'`,
커스텀 필드는 `sqlite`→`json_extract(cf, ?)`, `mysql`→`JSON_UNQUOTE(JSON_EXTRACT(cf, ?))`+NUMBER/DATE `CAST`,
`ansi`는 커스텀 필드 미지원(에러).

## `@openiql/adapter-opensearch` — `toOpenSearch(resolved, options?) → OpenSearchQuery`

`{ body, query, sort }` — `client.search({ index, body })`로 실행.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `customFieldsPath` | `'custom_fields'` | 커스텀 필드 루트 |
| `keywordSuffix` | `'.keyword'` | STRING 정확매치/정렬 서브필드 (`''`로 해제) |
| `trackTotalHits` | — | `track_total_hits` 전달 |
| `tieBreaker` | — | 정렬 꼬리 필드 |
| `changelog.*` | `path:'changelogs'`, `field`, `from_value`, `to_value` | `nested` 이력 필드 |

`=`/`IN`/정렬은 `.keyword` 서브필드, `~`는 `case_insensitive` wildcard, `WAS`/`CHANGED`는 `nested` 쿼리입니다.

---

## 공통 어댑터 계약

```ts
interface Adapter<TOutput, TOptions> { transpile(query: ResolvedQuery, options?: TOptions): TOutput }
// postgresAdapter, sqlAdapter, openSearchAdapter
```

모든 어댑터는 사용자 값을 파라미터로만 전달하고, 식별자(테이블·컬럼·경로)는 신뢰된 스키마/옵션에서만
유래해 엄격한 패턴으로 검증합니다 — 문자열 결합으로 SQL/DSL을 만들지 않습니다.
