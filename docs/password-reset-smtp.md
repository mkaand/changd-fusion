# Password reset email

Password reset delivery uses a dedicated server-managed SMTP configuration. It
never uses SMTP or Telegram notification channels, which may be editable by a
Public Access visitor. Configure `RECOVERY_SMTP_HOST`, `RECOVERY_SMTP_PORT`
(`465` or `587`), `RECOVERY_SMTP_FROM`, and, when authentication is required,
both `RECOVERY_SMTP_USERNAME` and `RECOVERY_SMTP_PASSWORD` in the deployment
secret manager or runtime environment. Use a trusted relay with TLS; do not
place these values in the database, browser storage, source control, or the
Notifications UI.

The reset endpoint always returns the same accepted response whether an account
or recovery SMTP configuration exists. This prevents account enumeration. If
recovery SMTP is absent, the server returns the same accepted response and does
not mint a reset token or use a notification channel. It logs only the safe code
`password_reset_smtp_unconfigured`; configure the server-managed recovery relay,
then request a new reset link. Reset tokens are hashed, single-use, and expire
after 20 minutes.
