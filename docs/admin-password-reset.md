# Administrator password reset

Password recovery is intentionally not available through the web application.
An authorized operator can reset a password only from an interactive server
terminal after identifying exactly one active administrator.

Run the built application with a TTY and its normal `DATABASE_URL` runtime
environment:

```sh
node dist/reset-admin-password.js
```

The command accepts no arguments. It asks twice for a hidden password, requires
12–72 UTF-8 bytes, selects exactly one active `user_type = 2` account inside a
transaction, stores a bcrypt hash, and revokes that account's active sessions
and account-security grants. It does not print the password, target email, or
hash, and it does not modify monitors, history, or notification channels.

If there are zero or multiple active administrators, the command fails without
choosing an account or changing data. Run it only from an authorized terminal;
do not redirect input or place a password in command-line arguments.
