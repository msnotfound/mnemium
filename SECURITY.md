# Security Policy

## Supported versions

Mnemium is pre-1.0. Only the **latest release** is supported for
security fixes. Older releases are out of scope.

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |
| Older   | ❌        |

## Reporting a vulnerability

**Do not open a public issue for security-impacting bugs.**

Instead, email the maintainer at the address listed on the
[msnotfound GitHub profile](https://github.com/msnotfound), with a
subject line beginning `mnemium-security:` and a description of:

1. The behavior you observed
2. The smallest reproducible case
3. What an attacker could achieve

You should expect an acknowledgement within 72 hours.

## Threat model (what Mnemium tries to defend against)

- **Random web pages probing the daemon.** The daemon binds to
  `127.0.0.1` only and requires a bearer token on every request.
  The token is generated per install with `crypto/rand`, stored
  with 0600 permissions, and never appears in logs.
- **Cross-origin reads via the extension.** Content scripts run
  only on the explicit host list in `wxt.config.ts`. They emit
  structured RPC messages to the service worker; they don't have
  blanket page access.
- **Sensitive data exfiltration.** No telemetry. The daemon's
  network egress is to the backends *you* configured (e.g. an
  OpenAI endpoint with your key). The default Recommended preset
  has zero external network egress after install.

## Out of scope

- **Auditing chat-provider security.** If ChatGPT / Claude /
  Gemini / Grok / DeepSeek themselves have a vulnerability that
  affects how Mnemium captures, that's on them, not us.
- **Model behavior.** The on-device LLM is what it is; Mnemium
  doesn't try to defend against the model writing something
  hallucinated to your memory store. The audit ledger lets you
  see exactly what got materialized.
- **Physical access to your machine.** Disk encryption + screen
  lock are your responsibility.
