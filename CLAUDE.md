# CLAUDE.md

`@tantchen/fritzbox` – typed FRITZ!Box client (session/PBKDF2, AHA thermostats, TR-064 hosts),
successor of `@tantchen/fritzapi`. First consumer: `~/Private/fritz-thermostat` (API).

## Working rules

- Private package, single maintainer. Work on `main`, commit each finished logical change without
  asking. Pushing, tagging and publishing are done by the maintainer – never publish or push tags.
- Releases: a pushed tag `v<version>` is published by `.github/workflows/publish.yml` (trusted
  publishing, provenance, no token). `scripts/publish.local.sh` (git-ignored) is the manual
  fallback: web login in the container with passkey, staged publish that has to be approved on
  npmjs.com, tag push. It must run in a real terminal (npm prints URLs and waits). GitHub actions stay pinned to commit SHAs.
- Development **only inside Docker** (`compose.yaml`): never run `npm install`, `npm ci`, `npx`,
  `node` or package code on the host; use `docker compose exec dev …`.
- **No runtime dependencies.** Supply chain: before adding any dependency (also dev), verify name,
  publisher and source, say what is added and wait for confirmation. No install scripts.
- Never change anything on the real box from tests or scripts. `scripts/smoke.ts` is read-only;
  thermostat writes are only tested against the fake fetch.
- Session ids and passwords never go into error messages or logs (`redact()` in `http.ts`).

## Layout

- `src/session.ts` – login_sid.lua (version=2), PBKDF2 + MD5 responses, `withSid()` re-login on 403
- `src/aha.ts` – homeautoswitch.lua, device list → `Thermostat`, target encoding (16–56 half
  degrees, 253 = OFF, 254 = ON)
- `src/hosts.ts` – TR-064 `Hosts:1` SOAP client with digest fallback
- `src/xml-tree.ts` / `src/xml.ts` – minimal XML reading (no dependency)
- `src/http.ts` – the only network access, injectable `fetch`
- `test/` – `node:test`, run directly from TypeScript (Node type stripping); `fake-fetch.ts`
  replaces the network

## Code style

TypeScript with `erasableSyntaxOnly` (no enums, no parameter properties) so Node runs the sources
directly. Code, comments and commit messages in English; comments explain *why*.
