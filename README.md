# @tantchen/fritzbox

Typed FRITZ!Box client for Node.js **without runtime dependencies**:

- **Session login** (`login_sid.lua`) with PBKDF2 (FRITZ!OS ≥ 7.24) and MD5 fallback, cached
  session id, automatic re-login when the box drops the session (HTTP 403)
- **AHA smart home**: radiator thermostats (FRITZ!DECT 301/302, Comet DECT, …) – read and set
  the target temperature
- **TR-064 host list** (`Hosts:1`): which devices the box knows and which are connected,
  with HTTP digest fallback

Successor of `@tantchen/fritzapi`, written from scratch: values have their real types, ON/OFF
are explicit modes instead of magic numbers, and HTTP status codes survive in the errors.

## Usage

```ts
import {FritzBox} from '@tantchen/fritzbox'

const box = new FritzBox({url: 'http://192.168.178.1', username: 'smarthome', password: '…'})

for (const t of await box.thermostats()) {
    console.log(t.name, t.measuredCelsius, t.target)   // target: {mode: 'temperature', celsius: 21.5} | {mode: 'on'} | {mode: 'off'}
}
await box.setTargetTemperature('119630157568', 21.5)   // or 'on' / 'off'

const phone = await box.hosts.byMac('AA:BB:CC:DD:EE:FF')
console.log(phone?.active)

await box.logout()
```

A FRITZ!Box user with only the **Smart Home** right is enough for thermostats and the host
list. Temperatures outside 8–28 °C or off the 0.5 °C grid are rejected with a `RangeError`, not
clamped.

### Errors

All errors extend `FritzError`:

| Class | When |
|---|---|
| `FritzNetworkError` | box not reachable, timeout |
| `FritzHttpError` | unexpected HTTP status (`status`) |
| `FritzAuthError` | login rejected (`blockTime` in seconds) |
| `FritzSoapFault` | TR-064 fault (`errorCode`, e.g. 714 = unknown entry) |

Session ids and passwords never appear in error messages.

## Requirements

Node.js ≥ 22.12 (global `fetch`; CommonJS projects can `require()` this ES module).

## Development

Everything runs in Docker, nothing is installed on the host:

```bash
docker compose up -d
docker compose exec dev npm ci
docker compose exec dev npm test          # node:test, runs the TypeScript sources directly
docker compose exec dev npm run typecheck
docker compose exec dev npm run build
```

Read-only check against a real box (never changes anything):

```bash
docker compose exec -e FRITZ_USER=… -e FRITZ_PASSWORD=… dev npm run smoke
docker compose exec -e FRITZ_USER=… -e FRITZ_PASSWORD=… dev npm run smoke -- --record   # saves the raw device list
```

### Specification

- AVM, *AHA-HTTP-Interface* – <https://fritz.com/en/pages/interfaces>
- AVM, *Technical Note – Session ID* (PBKDF2 / MD5 login)
- AVM, *TR-064 – Hosts* (`hostsSCPD`)

## License

MIT
