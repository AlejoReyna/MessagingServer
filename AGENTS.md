# Private Chat

Read `docs/CONTRACT.md` and `packages/contracts/src/index.ts` before changing behavior. Keep DTOs and endpoints coordinated. Node 24, ESM, strict TypeScript, Fastify, Socket.IO, Prisma, PostgreSQL, Sharp, FFmpeg and Caddy form the existing architecture.

Exactly two precreated accounts, roles admin/member, one conversation. No public registration, frontend secrets or message contents in logs. Preserve server authorization, Argon2id, opaque revocable sessions, CSRF and strict socket Origin validation. HTTPS protects transport; do not describe it as end-to-end encryption.

Use synthetic fixtures. Never commit personal photos, credentials, database dumps, live deletion journals, private operational reports, local paths, or artwork without redistribution permission. Retain third-party license notices. New project artwork must have a documented origin.

Run appropriate checks and PostgreSQL integration against an isolated test database. Report commands and actual results; do not claim remote deployment or platform verification without execution. Do not overwrite another contributor's changes or rewrite Git history.
