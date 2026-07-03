# Repository Guidelines

## Project Structure & Module Organization

This repository is a Node.js 22+ TypeScript MCP sidecar for Directus. Source code lives in `src/`. The entrypoint is `src/index.ts`, MCP registration and transports are in `src/mcp/`, Directus API/schema code is in `src/directus/`, guarded operations are in `src/tools/`, and shared safety logic is in `src/safety/`. Tests are colocated under `src/test/**/*.test.ts`. Smoke-test scripts live in `scripts/`. Runtime configuration is documented in `.env.example`, with Docker support in `Dockerfile` and `docker-compose.yml`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: run `src/index.ts` through `tsx watch` for local development.
- `npm run build`: compile TypeScript to `dist/`.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm test`: run the Vitest suite once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run smoke:stdio` / `npm run smoke:http`: exercise built MCP transports with the smoke scripts.
- `docker compose up --build`: build and run the Streamable HTTP service locally.

## Coding Style & Naming Conventions

Use ESM TypeScript and include `.js` extensions in relative imports, matching the current `NodeNext` setup. Keep strict compiler settings clean: no implicit `any`, unused locals, unused parameters, or unchecked indexed access. Existing code uses two-space indentation, single quotes, trailing commas in multiline calls/objects, `camelCase` for functions and variables, and `PascalCase` for classes/types. Tool modules generally export `<name>Tool` from `src/tools/<name>.ts`.

## Testing Guidelines

Vitest is configured to include `src/test/**/*.test.ts`. Name tests by behavior or regression, for example `normalize.test.ts` or `bundleFlow.test.ts`. Prefer mocked `fetch` and in-memory stores over live Directus calls for unit coverage. Run `npm run typecheck` and `npm test` before opening changes; add smoke tests only when transport behavior changes.

## Commit & Pull Request Guidelines

Recent commits are short and informal, often version-oriented (`v5 stable`, `v3 single stable`) or brief feature summaries. Keep new commits concise but descriptive, such as `fix plan bundle verification`. Pull requests should describe the safety or behavior change, list validation commands run, link related issues, and include config or Docker notes when environment variables or transport behavior change.

## Security & Configuration Tips

Never commit `.env` or real Directus tokens. Keep mutation safety defaults conservative: dry-run first, verify before updates, and leave delete disabled unless explicitly required. When adding tools, preserve collection allowlist checks, system collection guards, schema validation, audit logging, and plan/apply safeguards.
