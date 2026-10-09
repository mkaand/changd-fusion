# Contributing

Keep contributions small enough to review, with a clear explanation of behavior, tradeoffs and validation. This repository is public.

AI-assisted contributions are welcome. State which tools assisted the work and independently review their output. Human review is required before merging: the repository owner remains responsible for project decisions, security, validation and maintenance. OpenAI ChatGPT or OpenAI Codex assistance does not imply OpenAI affiliation or endorsement.

Every Codex-assisted commit must include this trailer:

```text
Co-Authored-By: codex <codex@openai.com>
```

Run both builds, backend/frontend unit tests and relevant integration/browser tests. Do not skip failures silently, weaken assertions, or use uncontrolled external websites in tests. Use disposable local PostgreSQL databases, local browser fixtures and mocked SMTP/Telegram credentials. Report unsupported runtime capabilities honestly.

Never commit runtime environment files, secrets, logs, screenshots of private sites, data, backups, personal email addresses, production domains or identifying substrings, server addresses or infrastructure identifiers. Use example.com and synthetic fixtures. Maintain `.gitignore` and `.dockerignore`; run the privacy scanner against source and built assets and inspect proposed commits before pushing. Automated scanning supplements human review and cannot prove that every private identifying substring is absent.

Require ownership checks for all user resources; use parameterized SQL; preserve SSRF protection, TLS verification, authenticated screenshot access and browser sandboxing. Do not add a public scheduler trigger, enable registration by default, log provider credentials, or claim exactly-once external delivery without proof. Discuss security-sensitive designs before merging.

Preserve the original MIT license and Paul Aschmann attribution in all substantial distributions. Follow the documented feature-branch and draft-PR workflow; do not deploy or publish releases as part of development validation.
