# Contributing

Keep changes focused and explain the behavior they add or fix.

## Set up the project

```bash
npm ci
npm run typecheck
npm run build
npm test
```

The default test suite uses fake IMAP and SMTP adapters. It must run without credentials or external network access.

## Before opening a pull request

- Add tests for behavior changes and failure paths.
- Update the README when a tool, environment variable, default, limit, or security boundary changes.
- Keep provider endpoints, mailbox addresses, tokens, deployment files, and private infrastructure details out of commits.
- Preserve the disabled-by-default behavior of send, draft, and trash capabilities.
- Do not add permanent deletion or expunge behavior under the `mail_trash` tool.
- Run `npm run typecheck`, `npm run build`, and `npm test`.

Use the read-only integration check only with an account you control:

```bash
npm run test:integration
```

Do not run mutation tests against a live mailbox as part of a pull request.

## Security reports

Do not open a public issue for a vulnerability or leaked credential. Follow [`SECURITY.md`](SECURITY.md).
