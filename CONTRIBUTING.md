# Contributing

Thanks for taking a look. Issues and pull requests are both welcome, including small ones.

If you have found a security problem, do not open an issue. Follow [SECURITY.md](SECURITY.md) instead.

## Getting it running

[The README](README.md#quick-start) has the full setup. The short version is that you need Node 18 or newer, a `.env` filled in from [`.env.example`](.env.example), and a Neon Postgres database with the schema applied.

There is no build step. The frontend is plain HTML, CSS, and JavaScript served straight out of `Frontend/`, so editing a file and reloading the page is the whole loop. `npm run dev` restarts the API on change.

You need real API keys for the parts you are touching. TMDB covers movies and shows, IGDB covers games (through a Twitch client ID and secret), and Kitsu needs no key at all, so anime work is the cheapest to get started on.

## What CI will check

Everything below runs on every push and pull request, and all of it can be run locally first.

- `npm test`, which is the unit and smoke suites
- **Case-sensitive path checks.** CI runs on Linux, and most contributors are not. A `require('./Library')` or a `src="Common.js"` that works on Windows or macOS will fail the build. The smoke suite asserts that every entry file resolves with the exact casing on disk.
- **Relative `API_BASE`.** The frontend must not hardcode an API origin. The check fails if it finds one.
- **Boot check.** The server is started with no environment and is expected to exit rather than come up half-working.
- **Semgrep SAST** over `Backend/` and `Frontend/`, which fails on any `WARNING` or `ERROR` finding. If you hit a genuine false positive, suppress that one line with a `nosemgrep` comment and say in the comment why it is safe. The exact command is in the README.

`npm run test:e2e` runs the Playwright suite. It is worth running if you touched a user flow, though CI runs it in its own workflow.

## Writing the code

Match what is already in the file you are editing. The codebase is deliberately plain: no framework, no bundler, and no new dependency unless it genuinely earns its place. If you are adding a route, look at how the neighbouring routes in `Backend/` are put together and follow that shape.

A few conventions that are easy to trip over:

- **No em dashes**, anywhere: not in the UI, not in docs, not in comments. Use commas, colons, or a full stop.
- New media categories go in as another `media_type` value, not as a new table. The [media model section](README.md#media-model) explains why.
- Anything user-facing needs to work signed out, or fail gracefully when it cannot.
- Keep light and dark both working. Each category has its own accent color, so check your change against more than one.

## Commits and pull requests

Write commit subjects as a plain sentence saying what changed, in the present tense, the way the existing history reads: "Land on the dashboard after signing in, not the Games page". No prefixes or tags. Put the reasoning in the body when the subject cannot carry it.

Keep a pull request to one thing. The template asks for a summary and a test plan; filling both in honestly, including what you did not test, is more useful than ticking every box.

## Reporting a bug

Use the issue template and include what you did, what happened, and what you expected. Say which category you were in, since movies, shows, anime, and games each come from a different provider and bugs are frequently specific to one of them.
