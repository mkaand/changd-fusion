# Production access: one-time authorization

This helper prepares secure SSH transport and read-only inventory. It does not deploy, create production directories, change Hestia/Nginx, modify Cloudflare, migrate customer data or configure CI/CD.

Use an existing authorized administrative SSH account for the initial installation. No credentials belong in chat, repository files, PR descriptions or CI logs. A public key can be authorized without sharing the server's private keys or root password. The Cloud-generated private key stays exclusively in its owner-only private directory. Use the restrictive, expiring authorized-key entry supplied privately for the task; do not commit it. Non-root inventory requires existing noninteractive sudo authorization, and does not grant new sudo permissions.

Configure these values only in the private Cloud environment settings:

- `PRODUCTION_SSH_HOST`: actual authorized SSH endpoint, not an inferred CDN/proxied application address.
- `PRODUCTION_SSH_USER`: existing authorized SSH account.
- `PRODUCTION_SSH_PORT`: SSH port, default 22.
- `PRODUCTION_SSH_HOST_KEY`: the server's **public** Ed25519 host key verified through the existing hosting console or another trusted channel. It is not a private key. Unknown keys are not trusted on first use.

The environment draft must be saved/published for runtime use. Saving requirements alone does not establish access. No private key, password or token is requested through these fields.

The engineer runs `python3 scripts/production-access.py check`, then `preflight`. Both require exact server-host-key verification, one explicit local identity, no agent/port/X11 forwarding, no interactive password, and finite timeouts. Output only reports a generic connection status. SSH errors and server inventory remain owner-only files in the Cloud private directory outside the repository; never upload them as CI artifacts.

Inventory covers OS/kernel, CPU/RAM/SWAP/disk, Docker/Compose, running containers and current resource usage, listeners, firewall, AppArmor/user namespace policy, Nginx syntax, Hestia package metadata, failed services and backup timer metadata. It deliberately excludes complete container environments, `nginx -T`, credential/configuration dumps and other applications' logs. This is an initial inventory, not a completed production acceptance test: target-specific Hestia configuration, existing TLS/backup verification, Ubuntu 24.04 sandbox tests, deployment, private shared-ui integration and automated updates still require a successful real connection and subsequent inspection.

Before changing anything on the server, inspect conflicts and back up the target configuration. Keep real domains, addresses, private UI source, admin credentials, service configuration and backups only in private operational storage. The project owner's original MIT attribution and public contribution policy still apply. Draft PR state does not authorize automatic merging.
