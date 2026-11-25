# OpenIQL 기반 아키텍처 및 사전 개발 명세서

> **참고**: 이 문서는 최초 초안입니다. 현재 공식 명세는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)이며,
> v0.1 구현 과정에서 확정된 변경 사항은 해당 문서 §8에 정리돼 있습니다.

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
| **시간 함수** | `startOfDay()`, `startOfWeek()` | 상대 오프셋(`-7d`, `+1w`) 계산 지원 | `created_at >= DATE_TRUNC('day', NOW())` |

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
  values: Array<LiteralValue FunctionCallValue |>;
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
  fromValue?: LiteralValue | FunctionCallValue;
  toValue?: LiteralValue | FunctionCallValue;
}

export type LiteralValue = {
  kind: 'string' | 'number' | 'boolean';
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
├── LICENSE                     # Apache-2.0 또는 MIT 라이선스
├── CONTRIBUTING.md             # 클린룸 개발 원칙 및 DCO(Developer Certificate of Origin) 서명 규칙
├── docs/
│   └── ARCHITECTURE.md         # 본 기반 아키텍처 및 사전 개발 명세서
├── spec/
│   └── grammar.ebnf            # 공식 EBNF 문법 정의 파일
├── packages/
│   ├── core/                   # 무의존성 Lexer, Recursive Descent Parser, AST 타입 정의
│   ├── adapter-postgres/       # AST -> PostgreSQL(JSONB 포함) Parameterized SQL 변환기
│   └── adapter-opensearch/     # AST -> OpenSearch Query DSL 변환기
└── tests/
    ├── parser.test.ts          # 연산자 우선순위, 괄호 중첩, 에러 위치 반환 검증
    └── security.test.ts        # SQL Injection 차단, 화이트리스트 검증, DoS 임계치 검증
```

### 클린룸 개발 및 기여 규칙
1. **외부 코드 오염 차단**: 모든 기여자는 PR 제출 시 DCO(Developer Certificate of Origin)를 통해 해당 코드가 독자적으로 작성되었으며 타 상용 제품의 디컴파일 코드나 GPL 계열 카피레프트 코드를 포함하지 않음을 보증합니다.
2. **명세 우선 개발(Spec-First)**: 새로운 연산자나 내장 함수를 추가할 때는 반드시 `spec/grammar.ebnf`와 본 문서를 먼저 갱신한 뒤 구현 코드와 테스트를 작성합니다.