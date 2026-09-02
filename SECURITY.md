# Security Policy

## Reporting a vulnerability

If you find a security issue in MediaListory, please **do not open a public issue**.
Instead, report it privately via GitHub's
[**Report a vulnerability**](https://github.com/Gr33nOps/MediaListory/security/advisories/new)
(Security → Advisories), which opens a private channel with the maintainer.

Please include:

- what the issue is and where (page, endpoint, or file),
- steps to reproduce or a proof of concept, and
- the impact you think it has.

You'll get an acknowledgement as soon as possible. Please give a reasonable
window to fix the issue before any public disclosure.

## Scope

In scope: this repository and the live app at
[medialistory.onrender.com](https://medialistory.onrender.com) — for example
authentication/session handling, access control between users, injection, or
data exposure.

Out of scope: findings against third-party providers (TMDB, Kitsu, IGDB/Twitch,
Neon, Render, Sentry) themselves, and reports that require a compromised device
or physical access.

## Good to know

- The app mints its own session JWT in an httpOnly cookie; social sign-in uses a
  self-hosted, same-origin OAuth2 code flow (Google/GitHub), so cookies stay
  first-party.
- All secrets live in environment variables (never in the repo); see
  [`.env.example`](.env.example).
- CI runs a Semgrep SAST scan on every change.
