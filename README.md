# imap-mcp

`imap-mcp` exposes one IMAP mailbox as seven MCP tools over Streamable HTTP. Read tools work once IMAP is configured. Sending, draft creation, and trash moves stay off until you enable each capability.

The server uses standard IMAP and SMTP settings. It does not select a mail provider or endpoint for you.

## What it exposes

| Tool | Behavior |
| --- | --- |
| `mail_health` | Check the server and its IMAP connection. |
| `mail_list_folders` | List folders and IMAP special-use flags. |
| `mail_search` | Search by sender, recipient, subject, date, or unread status. Results use the highest UIDs first, up to 50 messages. |
| `mail_get` | Read one message by folder and UID. Returns capped text, a short HTML excerpt, and attachment metadata. |
| `mail_send` | Send a plain-text email when `ALLOW_SEND=true`. |
| `mail_create_draft` | Append a plain-text draft when `ALLOW_SEND=true`. |
| `mail_trash` | Move one message to the unique folder marked `\Trash` when `ALLOW_TRASH=true`. |

`mail_trash` uses IMAP MOVE. It does not delete or expunge messages. Send/draft and trash operations have separate rate limits.

## Requirements

- Node.js 22.9 or newer
- An IMAP account
- An SMTP account if you enable sending
- TLS in front of the HTTP endpoint when it is reachable over a network

## Quick start

```bash
cp .env.example .env
openssl rand -base64 32
npm ci
npm run build
npm start
```

Put the generated token in `MCP_AUTH_TOKEN`, then fill in the IMAP values in `.env`. The server listens on `127.0.0.1:3000` by default and accepts MCP requests at `POST /mcp`.

Clients must send the token as a bearer:

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

[`examples/mcp.json`](examples/mcp.json) contains a client configuration with placeholder values.

## Configuration

### Core settings

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | required | At least 16 characters, with no leading or trailing whitespace. |
| `IMAP_HOST` | required | IMAP hostname. |
| `IMAP_PORT` | `993` | Integer from 1 to 65535. |
| `IMAP_TLS` | `true` | Accepts only `true` or `false`. |
| `IMAP_USER` | required | Provider username. It does not need to be an email address. |
| `IMAP_PASS` | required | Preserved exactly, including leading or trailing spaces. |
| `IMAP_TIMEOUT_MS` | `15000` | Timeout for each IMAP operation. |
| `HOST` | `127.0.0.1` | HTTP bind address. |
| `PORT` | `3000` | HTTP port. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

### Send and draft settings

| Variable | Default | Notes |
| --- | --- | --- |
| `ALLOW_SEND` | `false` | Enables `mail_send` and `mail_create_draft`. |
| `SEND_RATE_PER_HOUR` | `5` | Shared limit for sends and drafts, per process. |
| `SMTP_HOST` | required when enabled | SMTP hostname. |
| `SMTP_SECURITY` | required when enabled | `implicit` or `starttls`. |
| `SMTP_PORT` | `465` or `587` | Defaults from `SMTP_SECURITY`; an explicit value overrides it. |
| `SMTP_USER`, `SMTP_PASS` | IMAP credentials | Set both or neither. |
| `MAIL_FROM` | resolved SMTP user | Required when the SMTP username is not an email address. |

### Trash settings

| Variable | Default | Notes |
| --- | --- | --- |
| `ALLOW_TRASH` | `false` | Enables `mail_trash`. |
| `TRASH_RATE_PER_HOUR` | `20` | Independent move limit, per process. |

## Runtime boundaries

```text
MCP client
    │  HTTPS + bearer token
    ▼
TLS reverse proxy
    │  POST /mcp
    ▼
HTTP transport → MCP adapter → MailAccount
                                ├─ IMAP: read, draft, move
                                └─ SMTP: send
```

`MailAccount` owns capability checks and rate limits. The MCP layer validates tool input and maps domain errors. IMAP and SMTP adapters contain provider protocol details. See [`CONTEXT.md`](CONTEXT.md) for the domain terms used in the code.

Deployment is intentionally outside this repository. The tracked project contains no service unit, tunnel configuration, private hostname, or provider-specific endpoint.

## Security notes

- Keep the default loopback bind unless a trusted reverse proxy handles TLS and access control.
- Treat the bearer token as mailbox access. Rotate it after suspected exposure.
- Keep `ALLOW_SEND` and `ALLOW_TRASH` disabled unless the connected client should mutate the mailbox.
- Store credentials in the runtime environment. Do not add `.env` or client tokens to the repository.
- Application logs record operation names, status, latency, and provider error messages. They do not intentionally log message subjects or bodies.
- `mail_get` downloads at most 10 MB per message for parsing. It never returns attachment contents.

Prompt injection in an email can influence an MCP client or agent that reads it. The server limits mutation scope and frequency, but the client remains responsible for deciding when a tool call is appropriate.

Report vulnerabilities through the process in [`SECURITY.md`](SECURITY.md).

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

The default suite uses fake mail adapters and does not need mailbox credentials or external network access. Provide `.env` only when you want the read-only IMAP integration check:

```bash
npm run test:integration
```

The integration check connects to the configured account and searches for at most one message. It does not send, draft, move, or delete mail.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## Known limits

- One server process handles one mailbox account.
- UIDs belong to one folder and UIDVALIDITY. A stale UID returns `not_found`.
- HTML-only messages use best-effort text extraction.
- The server has no conversation model, attachment download, BCC, HTML sending, or permanent-delete tool.
- Rate-limit state lives in memory and resets when the process restarts.

## License

[MIT](LICENSE)
