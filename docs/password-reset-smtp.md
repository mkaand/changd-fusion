# Password reset email

Password reset delivery uses the first enabled SMTP notification channel owned
by the account requesting the reset. Configure a channel in **Notifications**
with its SMTP host, port, sender address, and credentials. The channel secret
is encrypted at rest and is never returned by the API.

The reset endpoint always returns the same accepted response whether an account
or SMTP channel exists. This prevents account enumeration. If no SMTP channel
is configured, the server logs the safe code
`password_reset_smtp_unconfigured`; configure and enable an SMTP channel, then
request a new reset link. Reset tokens are hashed, single-use, and expire after
20 minutes.
