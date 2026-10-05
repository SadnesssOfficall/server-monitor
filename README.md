# server-monitor

Uptime monitoring with a separate REST API and check worker.

## Description

`server-monitor` checks HTTP, HTTPS, TCP, ping and keyword targets on a schedule, keeps the
history, opens and closes incidents, and notifies you through Discord, signed webhooks or email.
The API and the worker are two independent processes that share one storage backend (a JSON file
or PostgreSQL). Monitoring is built to be safe against SSRF: private, loopback, link-local and
metadata addresses are blocked unless you opt in.

## Features

- Monitor types: `http`, `https` (certificate validation and expiry warning), `tcp`, `ping`, `keyword`
- Per monitor: interval, timeout, expected status range, redirect limit, failure and recovery thresholds
- Flapping protection: a monitor goes DOWN only after N consecutive failures
- Uptime for 24 hours, 7 days and 30 days, response time average and p95, downtime, incident history
- Retention: old checks and resolved incidents are removed automatically
- Notifications: Discord webhook, generic webhook signed with HMAC-SHA256, email over SMTP (TLS or STARTTLS)
- Notification retry with backoff and a cooldown that prevents alert spam
- SSRF protection with DNS pinning and re-validation of every redirect
- REST API with Bearer authentication, input validation and request size limits
- Storage adapters: in-memory, JSON file, PostgreSQL
- Zero runtime dependencies (the `pg` driver is optional and only needed for PostgreSQL)

## Installation

Requires Node.js 20 or newer.

```sh
git clone https://github.com/SadnesssOfficall/server-monitor.git
cd server-monitor
npm install
npm run build
```

Run the CLI from the checkout:

```sh
node dist/cli/bin.js --help
```

After `npm link` (or a global install) the command is `server-monitor`.

## Usage

```text
server-monitor api                      Start the REST API
server-monitor worker                   Start the check worker
server-monitor check <target> [options] Run a single check and exit
```

### One-off check

```sh
node dist/cli/bin.js check https://example.com
node dist/cli/bin.js check https://example.com --expect 200-299 --timeout 5000 --json
node dist/cli/bin.js check https://example.com -k "Example Domain"
node dist/cli/bin.js check example.com:443 --type tcp
node dist/cli/bin.js check example.com --type ping
```

The exit code is `0` when the target is up, `1` when it is down and `2` for usage errors.

| Option                 | Meaning                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `-t, --type <type>`    | `http`, `https`, `tcp`, `ping` or `keyword` (default: from URL) |
| `-k, --keyword <text>` | Require this text in the response body                          |
| `--expect <range>`     | Accepted status code or range, for example `200` or `200-299`   |
| `--timeout <ms>`       | Timeout in milliseconds                                         |
| `--redirects <n>`      | Maximum redirects to follow                                     |
| `--allow-private`      | Allow private, loopback and link-local targets                  |
| `--json`               | Print the result as JSON                                        |

### Running the services

The API and the worker must point at the same storage.

```sh
export SERVER_MONITOR_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
node dist/cli/bin.js api &
node dist/cli/bin.js worker &
```

The API listens on `127.0.0.1:8080` by default and stores data in `./data/server-monitor.json`.

## Configuration

All settings are environment variables.

| Variable                               | Default                      | Description                                                 |
| -------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `SERVER_MONITOR_TOKEN`                 | none                         | Bearer token for the API (required, at least 24 characters) |
| `SERVER_MONITOR_HOST`                  | `127.0.0.1`                  | API bind address                                            |
| `SERVER_MONITOR_PORT`                  | `8080`                       | API port                                                    |
| `SERVER_MONITOR_STORAGE`               | `json`                       | `json` or `postgres`                                        |
| `SERVER_MONITOR_DATA_FILE`             | `./data/server-monitor.json` | JSON storage file                                           |
| `PG_URL`                               | none                         | PostgreSQL connection string (required for `postgres`)      |
| `SERVER_MONITOR_ALLOW_PRIVATE_TARGETS` | `false`                      | Allow monitoring private and loopback addresses             |
| `SERVER_MONITOR_RETENTION_DAYS`        | `30`                         | How long checks and resolved incidents are kept             |

### Monitor fields

| Field                         | Default | Limits                                                      |
| ----------------------------- | ------- | ----------------------------------------------------------- |
| `name`, `type`, `target`      | -       | `type`: `http`, `https`, `tcp`, `ping`, `keyword`           |
| `enabled`                     | `true`  |                                                             |
| `intervalSeconds`             | `60`    | 10 to 86400                                                 |
| `timeoutMs`                   | `10000` | 500 to 60000, shorter than the interval                     |
| `expectedStatus`              | 200-299 | `{ "min": 200, "max": 299 }`, 100 to 599                    |
| `maxRedirects`                | `5`     | 0 to 10 (`0` does not follow redirects)                     |
| `failureThreshold`            | `3`     | 1 to 20 consecutive failures before DOWN                    |
| `recoveryThreshold`           | `1`     | 1 to 20 consecutive successes before UP                     |
| `keyword`, `keywordMode`      | -       | `present` (default) or `absent`; keyword max 200 characters |
| `maxBodyBytes`                | 262144  | 1024 to 1048576, how much of the body is inspected          |
| `certExpiryWarnDays`          | `14`    | 0 to 365                                                    |
| `notificationCooldownSeconds` | `900`   | 0 to 86400                                                  |
| `channelIds`                  | `[]`    | Up to 20 notification channels                              |

Targets: `http` and `https` take a URL, `keyword` takes either, `tcp` takes `host:port`, `ping`
takes a hostname or IP address. URLs must not contain credentials.

## Examples

Set the token once for the examples below.

```sh
export TOKEN="$SERVER_MONITOR_TOKEN"
```

Create a monitor:

```sh
curl -s -X POST http://127.0.0.1:8080/v1/monitors \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Example","type":"https","target":"https://example.com","intervalSeconds":30}'
```

Add a Discord channel and attach it to a monitor:

```sh
curl -s -X POST http://127.0.0.1:8080/v1/channels \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"discord","name":"alerts","url":"https://discord.com/api/webhooks/ID/TOKEN"}'

curl -s -X PATCH http://127.0.0.1:8080/v1/monitors/<monitor-id> \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channelIds":["<channel-id>"]}'
```

Read status, uptime and history:

```sh
curl -s http://127.0.0.1:8080/v1/monitors/<monitor-id> -H "Authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:8080/v1/monitors/<monitor-id>/checks?limit=20" -H "Authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:8080/v1/incidents?open=true" -H "Authorization: Bearer $TOKEN"
```

### API reference

| Method and path                  | Description                                             |
| -------------------------------- | ------------------------------------------------------- |
| `GET /health`                    | Liveness probe, no authentication                       |
| `GET /v1/monitors`               | List monitors with their current state                  |
| `POST /v1/monitors`              | Create a monitor                                        |
| `GET /v1/monitors/:id`           | Monitor, state, uptime (24h, 7d, 30d) and response time |
| `PATCH /v1/monitors/:id`         | Change fields, the merged result is validated           |
| `DELETE /v1/monitors/:id`        | Delete a monitor with its checks and incidents          |
| `GET /v1/monitors/:id/checks`    | History, newest first (`limit`, `since`, `until`)       |
| `GET /v1/monitors/:id/incidents` | Incidents with start, end and duration                  |
| `GET /v1/incidents`              | All incidents (`open=true`, `limit`)                    |
| `GET, POST /v1/channels`         | List and create notification channels                   |
| `GET, DELETE /v1/channels/:id`   | Read and delete a channel                               |

Errors use `{ "error": { "code", "message", "details" } }`. Validation failures return `422`
with one entry per invalid field.

### Notification channels

| Type      | Fields                                                                                 |
| --------- | -------------------------------------------------------------------------------------- |
| `discord` | `url`                                                                                  |
| `webhook` | `url`, optional `secret` (generated and returned once as `signingSecret` if omitted)   |
| `email`   | `host`, `port`, `security` (`starttls` or `tls`), `username`, `password`, `from`, `to` |

Events: `incident_opened`, `incident_resolved`, `certificate_expiring`.

Webhook requests carry `X-Monitor-Timestamp`, `X-Monitor-Event` and
`X-Monitor-Signature: sha256=<hex>`, where the signature is HMAC-SHA256 over
`<timestamp>.<raw body>`. Verify it in your receiver, for example with the exported helper:

```ts
import { verifyWebhookSignature } from 'server-monitor';

const valid = verifyWebhookSignature({
  secret,
  timestamp: request.headers['x-monitor-timestamp'],
  body: rawBody,
  signature: request.headers['x-monitor-signature'],
});
```

The helper compares in constant time and rejects timestamps older than five minutes.

### Docker Compose

```sh
cp .env.example .env
docker compose up --build
```

The compose file starts PostgreSQL, the API (published on `127.0.0.1:8080`) and the worker.
Use a password without URL-reserved characters for `POSTGRES_PASSWORD`, because it is placed in a
connection URL. The Docker files have not been run in the environment where this project was
written, see [Testing](#testing).

## Architecture

```text
src/core        Check runners, state machine, uptime maths, SSRF guard (pure and testable)
src/worker      Scheduler (jitter, no overlapping checks, graceful stop) and check processing
src/api         node:http REST API: routes, authentication, request limits, response views
src/storage     Storage interface with memory, JSON file and PostgreSQL adapters
src/notify      Notifier interface, Discord, webhook and SMTP notifiers, retry, dispatcher
src/validation  Input validation for monitors and channels
src/cli         api, worker and check commands
```

Design decisions:

- The worker and the API never talk to each other. They share storage, so either can restart
  without losing state. The JSON adapter uses a lock directory and atomic renames so both
  processes can write safely; PostgreSQL is the choice for anything beyond a single host.
- Incident state lives in storage next to the check history, so a worker restart continues an open
  incident instead of opening a new one.
- Email uses a small built-in SMTP client instead of `nodemailer`. It supports implicit TLS and
  STARTTLS, always verifies the server certificate, never falls back to plaintext and only sends
  credentials after TLS is established. If you need OAuth2, DKIM or other advanced features, add a
  `Notifier` that wraps `nodemailer`.
- Redis is not used. A shared lock or status broadcast is only needed when several workers must
  coordinate, and this design runs a single worker per storage. The storage lock (file lock or
  PostgreSQL) already covers the API and worker sharing data.
- Uptime is time-weighted: each check covers the time until the next check, capped at twice the
  interval plus the timeout. Periods without data (worker stopped) are excluded from the
  percentage instead of being counted as up or down. `uptimePercent` is `null` when there is no data.
- Ping runs the system `ping` command with an argument array and no shell (`-n`/`-w` on Windows,
  `-c`/`-W` on Linux and macOS), because ICMP raw sockets need privileges. If `ping` is missing the
  check fails with `ping command is not available`. In containers the unprivileged `ping` may need
  `CAP_NET_RAW`.

## Security

- Private, loopback, link-local, carrier-grade NAT, multicast, reserved and cloud metadata
  addresses (including IPv4-mapped IPv6 and NAT64 forms) are blocked for every monitor type and
  for notification targets. `SERVER_MONITOR_ALLOW_PRIVATE_TARGETS=true` disables the check.
- DNS is resolved once, every returned address is validated, and the connection is pinned to the
  validated IP. A hostname that changes its answer after validation (DNS rebinding) cannot redirect
  the request.
- Every redirect is resolved and validated again, and only `http` and `https` redirects are followed.
- The API token comes from the environment, is compared in constant time and is never logged or
  returned. Requests are limited to 64 KiB, must be `application/json`, and unknown fields are
  rejected.
- Webhook URLs, signing secrets, SMTP credentials and recipient addresses are masked or omitted in
  API responses. Logs contain monitor ids and error classes, never URLs or credentials.
- Error messages from checks are reduced to short classes such as `timeout` or
  `network: ECONNREFUSED`, so remote error text is not stored or shown.
- Not covered: the API has no rate limiting, and TLS termination is expected from a reverse proxy.
  Stored channel secrets are kept in plain text in the storage backend, so protect the data file or
  database accordingly (the JSON file is created with mode `0600`).

## Development

```sh
npm install
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

## Testing

```sh
npm test
```

The suite runs real checks against local HTTP, HTTPS, TCP and SMTP servers (up, down, timeout,
wrong status, missing keyword, redirects, certificate errors), the state machine, uptime maths,
SSRF protections (private ranges, DNS rebinding with an injected resolver, redirect escapes), API
authentication and validation, webhook signatures, retention and the CLI. The PostgreSQL adapter
is tested against an in-process PGlite database, so no server is needed. Setting `PG_URL` adds a
test against a real PostgreSQL server (CI does this).

Not verified here: the Dockerfile and `docker-compose.yml` were not built or run (no Docker in the
development environment); only their YAML syntax was validated. Tests against a real PostgreSQL
server run only when `PG_URL` is set.

## License

MIT. See [LICENSE](LICENSE).
