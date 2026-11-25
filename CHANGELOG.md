# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-25

### Added
- `@openiql/core`: dependency-free lexer, recursive-descent parser, AST types,
  schema whitelist (`createSchema`), resolver (`currentUser()`, `startOfDay()`,
  `startOfWeek()` with duration offsets), AST printer, structured errors
  (`SyntaxError`/`UnknownFieldError`/`LimitExceededError`/`ValidationError`)
  with line/column locations.
- `@openiql/adapter-postgres`: `toPostgres()` — parameterised `SELECT`
  generation (all user values bound, custom-field keys bound, identifier
  validation), NULL-inclusive `!=`/`NOT` semantics, `EXISTS`-based changelog
  queries for `WAS`/`CHANGED`.
- `@openiql/adapter-opensearch`: `toOpenSearch()` — `_search` request body
  generation (`.keyword` addressing, case-insensitive `wildcard` for `~`,
  `nested` changelog queries, same missing-field semantics as Postgres).
- `@openiql/adapter-sql`: `toSql()` — portable `?`-placeholder SQL for
  `sqlite`/`mysql`/`ansi` dialects (`LOWER() LIKE` for `~`, portable
  `IS DISTINCT FROM` emulation, dialect-specific JSON custom fields).
- `analyzeRequest()` — HTTP entry point dispatching `?q=` text queries and
  `?filter=` JSON ASTs (mutually exclusive; untrusted AST validated).
- Docs: `docs/API.md` public API reference, `docs/LEGAL-NOTES.md` IP review.
- DoS limits: 2,048-byte query cap, paren depth 10, `IN` list 100, ORDER BY 10
  items, JSON AST depth 1,000.
- Tests: 136 cases — parser, resolver, security, request, OpenSearch, plus
  real-database integration suites for PostgreSQL, MariaDB/MySQL (`mysql2`),
  OpenSearch 2 (all Docker, skipped without Docker) and SQLite (`node:sqlite`).
- Governance: Apache-2.0, clean-room/spec-first rules in `CONTRIBUTING.md`,
  DCO sign-off required on every commit (`npm run check:dco`).
- Docs: `docs/MANUAL.md` Korean usage manual with SVG diagrams, per-package
  READMEs for npm pages.
