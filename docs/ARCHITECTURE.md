# OpenIQL 기반 아키텍처 및 사전 개발 명세서

## 1. 개요 및 설계 철학

**OpenIQL (Open Issue Query Language)**은 이슈 트래킹 및 프로젝트 관리 시스템에서 복합 검색 조건(`AND`, `OR`, `NOT`, 괄호 중첩, 동적 함수, 정렬)을 단일 텍스트 쿼리 또는 UI 필터 객체로 입력받아, 안전하게 추상 구문 트리(AST)로 파싱하고 대상 데이터베이스(PostgreSQL `JSONB`, OpenSearch 등)의 실행 쿼리로 변환하는 오픈소스 쿼리 엔진입니다.

### 핵심 설계 원칙
* **표면 문법과 실행 엔진의 분리**: 실무자가 직관적으로 읽고 쓸 수 있는 SQL `WHERE` 절 스타일의 평면화된 조건문 문법을 채택하되, 내부적으로는 RDBMS(`JSONB` 및 파라미터 바인딩) 또는 역인덱스 검색 엔진(OpenSearch)으로 트랜스파일링하여 실행합니다.
* **UI 필터와의 양방향 호환성**: 일반 사용자는 프론트엔드 드롭다운 필터 UI만 사용하더라도, 백엔드에서는 동일한 표준 JSON AST와 쿼리 엔진을 통해 저장된 필터(Saved Filter), 보드(칸반/스크럼), 대시보드 위젯을 단일 인터페이스로 제어합니다.
* **클린룸(Clean-room) 독자 개발 및 상표 분리**: 상용 이슈 트래커의 바이너리나 원본 문법 파일을 역어셈블·복제하지 않고, 본 문서에 정의된 자체 EBNF 명세로부터 백지상태에서 파서와 어댑터를 구현합니다. 또한 외부 상표권과의 오인·혼동을 방지하기 위해 독자적인 명칭(`OpenIQL`)과 API 규격(`?q=`, `?filter=`)을 사용합니다.
* **보안 우선(Security-by-Default)**: 문자열 결합 방식의 동적 쿼리 생성을 원천 배제하고, 모든 사용자 입력값은 바인딩 파라미터(`$1`, `$2`...)로 분리하며 필드명은 화이트리스트 스키마 검증을 거칩니다.

---

## 2. 시스템 아키텍처 및 처리 파이프라인

입력된 쿼리는 총 4단계 파이프라인을 거쳐 안전한 실행 쿼리로 변환됩니다.

```text
[입력 문자열]  "project = PROJ AND (priority = High OR assignee = currentUser()) ORDER BY created DESC"
      │
      ▼  1. Lexer (어휘 분석기)
[토큰 스트림]  [IDENT(project), OP(=), IDENT(PROJ), KW(AND), LPAREN, ...]
      │
      ▼  2. Parser (구문 분석기 - Recursive Descent)
[추상 구문 트리] QueryAST {
  (JSON AST)     where: LogicalNode(AND, Comparison(project = PROJ), LogicalNode(OR, ...)),
                 orderBy: [{ field: "created", direction: "DESC" }]
               }
      │
      ▼  3. Validator & Context Resolver (검증 및 함수 평가)
[정규화된 AST]  • 화이트리스트 필드 매핑 (고정 컬럼 vs JSONB 커스텀 필드 판별)
               • 동적 함수 평가: currentUser() -> 컨텍스트 사용자 ID("usr_9921") 치환
      │
      ▼  4. Transpiler (DB / 검색 엔진 어댑터)
[실행 쿼리]    SELECT * FROM issues
               WHERE project_key = $1 AND (priority = $2 OR assignee_id = $3)
               ORDER BY created_at DESC
               -- Params: ["PROJ", "High", "usr_9921"]
```

---

## 3. 공식 문법 명세 (EBNF)

OpenIQL 파서가 수용하는 공식 문법 규칙입니다. 연산자 우선순위는 `괄호 ()` > `NOT` > `AND` > `OR` 순서를 따릅니다.

```ebnf
Query         ::= Expression? OrderByClause? EOF

Expression    ::= OrExpr
OrExpr        ::= AndExpr ( "OR" AndExpr )*
AndExpr       ::= NotExpr ( "AND" NotExpr )*
NotExpr       ::= "NOT" NotExpr | PrimaryExpr

PrimaryExpr   ::= "(" Expression ")"
                | Condition

Condition     ::= Field ComparisonOp Value
                | Field ListOp "(" ValueList ")"
                | Field NullOp
                | Field HistoryOp

ComparisonOp  ::= "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~"
ListOp        ::= "IN" | "NOT IN"
NullOp        ::= "IS EMPTY" | "IS NOT EMPTY"
HistoryOp     ::= "WAS" Value | "CHANGED" ( "FROM" Value )? ( "TO" Value )?

ValueList     ::= Value ( "," Value )*
Value         ::= StringLiteral | NumberLiteral | BooleanLiteral | FunctionCall | Identifier
FunctionCall  ::= Identifier "(" ( ValueList )? ")"

OrderByClause ::= "ORDER BY" OrderItem ( "," OrderItem )*
OrderItem     ::= Field ( "ASC" | "DESC" )?

Field         ::= Identifier ( "." Identifier )?
Identifier    ::= [a-zA-Z_][a-zA-Z0-9_]*
StringLiteral ::= '"' [^"]* '"' | "'" [^']* "'"
NumberLiteral ::= "-"? [0-9]+ ( "." [0-9]+ )?
BooleanLiteral::= "true" | "false"
```

---

## 4. 지원 연산자 및 내장 함수 명세

| 분류 | 연산자 / 함수 | 기능 설명 | PostgreSQL 변환 예시 |
| :--- | :--- | :--- | :--- |
| **비교 연산** | `=`, `!=`, `>`, `>=`, `<`, `<=` | 정확 일치 및 수치·날짜 대소 비교 | `status = $1` |
| **텍스트 검색** | `~`, `!~` | 부분 문자열 포함 여부 (대소문자 무시) | `summary ILIKE $1` (`%keyword%`) |
| **집합 연산** | `IN`, `NOT IN` | 다중 후보 값 중 포함 여부 검사 | `priority = ANY($1)` |
| **결측치 검사** | `IS EMPTY`, `IS NOT EMPTY` | `NULL` 또는 빈 값 여부 검사 | `assignee_id IS NULL` |
| **이력 추적** | `WAS`, `CHANGED FROM ... TO ...` | 변경 이력(Changelog) 테이블 기반 시계열 조회 | `EXISTS (SELECT 1 FROM issue_changelogs ...)` |
| **정렬 구문** | `ORDER BY field ASC\|DESC` | 다중 필드 정렬 (방향 생략 시 `ASC`) | `ORDER BY created_at DESC` |
| **사용자 함수** | `currentUser()` | 현재 인증 세션의 사용자 식별자 바인딩 | `assignee_id = $1` (`ctx.userId`) |
| **시간 함수** | `startOfDay()`, `startOfWeek()` | 상대 오프셋(`-7d`, `+1w`) 계산 지원 (UTC, 주 시작=월요일). Validator가 ISO 시각으로 평가 | `created_at >= $1::timestamptz` |

---

## 5. 표준 JSON AST 인터페이스

프론트엔드 UI 필터 빌더와 백엔드 파서 코어가 공통으로 사용하는 중간 데이터 구조입니다.

```typescript
export interface QueryAST {
  where: ASTNode | null;
  orderBy: Array<{
    field: string;
    direction: 'ASC' | 'DESC';
  }>;
}

export type ASTNode =
  | LogicalNode
  | NotNode
  | ComparisonNode
  | ListNode
  | NullCheckNode
  | HistoryNode;

export interface LogicalNode {
  type: 'Logical';
  operator: 'AND' | 'OR';
  left: ASTNode;
  right: ASTNode;
}

export interface NotNode {
  type: 'Not';
  operand: ASTNode;
}

export interface ComparisonNode {
  type: 'Comparison';
  field: string;
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | '!~';
  value: LiteralValue | FunctionCallValue;
}

export interface ListNode {
  type: 'List';
  field: string;
  operator: 'IN' | 'NOT IN';
  values: Array<LiteralValue | FunctionCallValue>;
}

export interface NullCheckNode {
  type: 'NullCheck';
  field: string;
  operator: 'IS EMPTY' | 'IS NOT EMPTY';
}

export interface HistoryNode {
  type: 'History';
  field: string;
  operator: 'WAS' | 'CHANGED';
  value?: LiteralValue | FunctionCallValue;      // WAS
  fromValue?: LiteralValue | FunctionCallValue;
  toValue?: LiteralValue | FunctionCallValue;
}

export type LiteralValue = {
  kind: 'string' | 'number' | 'boolean' | 'duration';  // duration: "-7d", function argument only
  value: string | number | boolean;
};

export type FunctionCallValue = {
  kind: 'function';
  name: string;
  args: LiteralValue[];
};
```

---

## 6. 보안 통제 및 예외 처리 규격

### 1. 스키마 레지스트리 (화이트리스트 매핑)
* 파싱된 `field` 식별자는 반드시 사전 등록된 스키마 매핑 테이블을 통과해야 합니다.
  * **고정 코어 필드**: `status` → `issues.status` (타입: `STRING`)
  * **동적 커스텀 필드**: `cf.story_points` → `(issues.custom_fields->>'story_points')::numeric` (타입: `NUMBER`)
* 매핑 테이블에 존재하지 않는 필드명이 입력되면 즉시 `UnknownFieldError`를 반환하여 임의 DB 컬럼 접근 및 정보 노출을 차단합니다.

### 2. 리소스 고갈(DoS) 방어 임계치
* **최대 쿼리 길이**: `2,048` 바이트 이내
* **최대 괄호 중첩 깊이**: `10` 단계 이내
* **`IN` 리스트 최대 원소 개수**: `100` 개 이내

### 3. 구문 오류 진단 포맷
* 파싱 실패 시 프론트엔드 검색 바에서 오류 위치를 시각적으로 표시할 수 있도록 토큰의 정확한 좌표와 기대 토큰 목록을 반환합니다.

```json
{
  "error": "SyntaxError",
  "message": "Unexpected token 'AND' at line 1, column 22",
  "location": { "offset": 21, "line": 1, "column": 22 },
  "expected": ["=", "!=", "IN", "IS EMPTY", "WAS", "CHANGED"]
}
```

---

## 7. 리포지토리 구조 및 오픈소스 거버넌스

```text
open-iql/
├── LICENSE                     # Apache-2.0
├── CONTRIBUTING.md             # 클린룸 개발 원칙 및 DCO(Developer Certificate of Origin) 서명 규칙
├── docs/
│   └── ARCHITECTURE.md         # 본 기반 아키텍처 및 사전 개발 명세서
├── spec/
│   └── grammar.ebnf            # 공식 EBNF 문법 정의 파일
├── packages/
│   ├── core/                   # 무의존성 Lexer, Recursive Descent Parser, AST 타입 정의, HTTP 진입점
│   ├── adapter-postgres/       # AST -> PostgreSQL(JSONB 포함) Parameterized SQL 변환기
│   ├── adapter-sql/            # AST -> 범용 SQL(SQLite/MySQL/ANSI) 변환기
│   └── adapter-opensearch/     # AST -> OpenSearch Query DSL 변환기
└── tests/
    ├── parser.test.ts              # 연산자 우선순위, 괄호 중첩, 에러 위치 반환 검증
    ├── resolver.test.ts            # 스키마 검증, 타입 강제, 함수 평가 검증
    ├── security.test.ts            # SQL Injection 차단, 화이트리스트 검증, DoS 임계치 검증
    ├── opensearch.test.ts          # OpenSearch Query DSL 변환 검증
    ├── sql.test.ts                 # 범용 SQL 변환 + 실제 SQLite 종단 검증 (node:sqlite)
    ├── request.test.ts             # ?q=/?filter= HTTP 진입점 검증
    └── postgres.integration.test.ts# 실제 PostgreSQL 대상 종단 검증 (Docker 필요, 없으면 skip)
```

### 클린룸 개발 및 기여 규칙
1. **외부 코드 오염 차단**: 모든 기여자는 PR 제출 시 DCO(Developer Certificate of Origin)를 통해 해당 코드가 독자적으로 작성되었으며 타 상용 제품의 디컴파일 코드나 GPL 계열 카피레프트 코드를 포함하지 않음을 보증합니다.
2. **명세 우선 개발(Spec-First)**: 새로운 연산자나 내장 함수를 추가할 때는 반드시 `spec/grammar.ebnf`와 본 문서를 먼저 갱신한 뒤 구현 코드와 테스트를 작성합니다.

---

## 8. v0.1 구현 시 확정된 명세 변경 사항 (base.md 대비)

| # | 변경 | 사유 |
|---|---|---|
| 1 | `ListNode.values` 타입 오타 수정 | 타입 문법 오류 |
| 2 | `HistoryNode.value` 추가 (`WAS`용) | `WAS`와 `CHANGED FROM/TO`의 의미 분리 |
| 3 | `DurationLiteral`(`[+-]?[0-9]+[smhdw]`) 추가, 함수 인자로만 허용 | `startOfDay(-7d)`가 기존 EBNF에 없었음 |
| 4 | 문자열 리터럴에 `\\`, `\"`, `\'` 이스케이프 허용 | 따옴표를 포함한 값을 표현·직렬화(print)할 수 없었음 |
| 5 | 함수 중첩 호출 금지, 키워드(`AND`, `OR`, ...)는 식별자로 사용 불가, 키워드·`true/false`는 대소문자 무시 | 모호성 제거 |
| 6 | 따옴표 없는 식별자 값(`project = PROJ`)은 문자열 리터럴로 취급 | 기존 `Value ::= Identifier`의 의미 확정 |
| 7 | 모든 AST 노드에 선택적 `span`(문자 오프셋) | 에러·UI 표시 |
| 8 | 쿼리 길이 제한은 UTF-8 바이트 기준 | 한글 등 멀티바이트 입력 |
| 9 | 시간 함수는 Validator에서 평가해 바인딩 파라미터로 전달 (`DATE_TRUNC(NOW())` 미사용) | 결정적 테스트, 시간대 일관성 |
| 10 | 추가 제한: ORDER BY 항목 10개, JSON AST 깊이 1000 | 신뢰할 수 없는 JSON AST 방어 |
| 11 | 범용 SQL 방언(sqlite/mysql/ansi) 및 `?q=`/`?filter=` 진입점 명세 추가 | §2 파이프라인의 "대상 DB"와 §1 API 규격 구체화 |

### Postgres 의미 규정
* `=`, `<`, `>` 등은 NULL과 매치하지 않고, `!=`는 NULL을 포함합니다(`IS DISTINCT FROM`). `NOT (...)`도 NULL 행을 포함합니다.
* `IS EMPTY`는 `NULL` 또는 빈 문자열입니다.
* `WAS v`는 changelog의 `from_value`/`to_value`가 `v`인 이슈입니다(생성 시 `NULL → 초기값` 행을 기록한다고 가정). `CHANGED FROM a TO b`는 두 조건을 모두 만족하는 단일 행을 찾습니다. changelog 값은 text로 비교합니다.
* 커스텀 필드 키도 바인딩 파라미터이며, `NUMBER` 필드의 JSONB 값이 숫자 문자열이 아니면 DB가 캐스팅 오류를 냅니다(스키마 쓰기 경로에서 보장해야 함).

### OpenSearch 의미 규정
* 출력물은 `POST /<index>/_search`의 요청 본문입니다. 모든 필드 경로는 신뢰된 스키마/옵션에서만 유래하며 사용자 입력값은 쿼리 파라미터로만 전달됩니다.
* `STRING` 필드의 `=`/`IN`/정렬은 `<path>.keyword` 서브필드를 사용합니다(기본 접미사 `.keyword`, 옵션으로 변경·비활성화 가능).
* `~`는 keyword 서브필드의 `wildcard` 쿼리(`*…*`, `case_insensitive: true`)로 변환되며, 사용자 입력의 `*`, `?`, `\`는 이스케이프됩니다.
* `!=`, `!~`, `NOT IN`, `NOT (...)`는 `bool.must_not`으로 변환되며 필드가 없는 문서도 매치합니다(Postgres의 NULL-포함 의미와 동일).
* `IS EMPTY`는 `must_not: exists` 이고 `STRING` 필드는 `term: ""` 도 포함합니다. `IS NOT EMPTY`는 `exists` 이고 `STRING` 필드는 `""`가 아님을 추가로 요구합니다.
* `WAS`/`CHANGED`는 `nested` 필드(기본 경로 `changelogs`, 하위 `field`/`from_value`/`to_value` keyword 필드)에 대한 `nested` 쿼리로 변환됩니다. 변경 이력을 별도 인덱스에 두는 배포에서는 이력 연산자를 사용할 수 없습니다.

### 범용 SQL (adapter-sql) 의미 규정
* `sqlite`/`mysql`/`ansi` 세 방언을 지원하며, 파라미터는 `?` 플레이스홀더입니다.
* `!=`는 `(col <> ? OR col IS NULL)`로 변환해 NULL 행을 포함합니다(ANSI `IS DISTINCT FROM` 미지원 방언 호환). `NOT (...)`, `NOT IN`, `!~`는 `NOT COALESCE(...)`로 동일하게 NULL을 포함합니다.
* `~`는 `LOWER(col) LIKE LOWER(?) ESCAPE '\'`로 변환합니다(방언별 대소문자 collation 차이 흡수, `%`/`_`/`\\` 이스케이프).
* 커스텀 필드: `sqlite`는 `json_extract(cf, ?)`(네이티브 타입 유지), `mysql`은 `JSON_UNQUOTE(JSON_EXTRACT(cf, ?))` + NUMBER/DATE는 `CAST` 적용. `ansi` 방언은 JSON 함수가 표준이 아니므로 커스텀 필드를 지원하지 않습니다(사용 시 에러).
* 이력 연산자는 표준 `EXISTS` 서브쿼리로 세 방언 공통입니다.

### HTTP API 규격 (`?q=` / `?filter=`)
* `?q=<text>`: 텍스트 쿼리 → `parse` → `resolve` 파이프라인.
* `?filter=<json>`: UI 필터 빌더의 표준 JSON AST(§5) → JSON 파싱 후 `resolve`(신뢰할 수 없는 AST로 검증·깊이 제한 적용). 이미 파싱된 객체도 허용합니다.
* 두 파라미터를 동시에 지정하면 `ValidationError`. 둘 다 없으면 조건 없는 전체 조회(`match_all`/`WHERE` 없음)입니다.
