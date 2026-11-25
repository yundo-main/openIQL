# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased] — v0.1

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
- DoS limits: 2,048-byte query cap, paren depth 10, `IN` list 100, ORDER BY 10
  items, JSON AST depth 1,000.
- Tests: 91 cases — parser, resolver, security, OpenSearch, and a real
  PostgreSQL integration suite (skipped without Docker).
- Governance: Apache-2.0, clean-room/spec-first rules in `CONTRIBUTING.md`,
  DCO sign-off required on every commit (`npm run check:dco`).
