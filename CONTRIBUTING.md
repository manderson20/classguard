# Contributing to ClassGuard

Thanks for considering a contribution. This project exists to give school
IT departments a free, self-hosted alternative to expensive commercial
filtering/classroom-management products — contributions that keep it
reliable and easy to run are genuinely valuable to a lot of districts
that couldn't otherwise afford this kind of tooling.

## How to Contribute

1. **Open an issue first for anything non-trivial** — a bug fix is
   usually fine to just submit, but a new feature or behavior change is
   easier to review (and less likely to be rejected after you've already
   written it) if discussed first.
2. Fork the repository and create a feature branch from `main`.
3. Make your change, with tests where practical for backend services
   and routes.
4. Open a pull request against `main`. CI will run lint and tests
   automatically.
5. Add an entry to `CHANGELOG.md` under `[Unreleased]` describing your
   change.

## Pull Request Expectations

- **Keep PRs focused.** One logical change per PR is much easier to
  review than a bundle of unrelated fixes.
- **Explain the "why," not just the "what."** Code review is faster when
  the PR description states the problem being solved, not just a
  description of the diff.
- **Don't break existing functionality** without flagging it clearly —
  this runs in production school networks; an unannounced breaking
  change can take a real network offline.
- Maintainers may ask for changes, decline a PR, or take time to review
  — this is a volunteer-maintained project, not a company with an SLA.

## Code Quality Expectations

- Match the existing code style and patterns already used in the file
  or module you're touching, rather than introducing a new convention.
- Avoid adding dependencies for something a few lines of code can do.
- Don't add speculative configuration, feature flags, or abstractions
  for hypothetical future use cases — solve the problem in front of you.
- Comment the *why* when something is non-obvious (a workaround, an
  invariant, a constraint discovered the hard way); don't comment the
  *what* when the code already reads clearly.
- Be careful with anything touching authentication, permissions, DNS/DHCP
  resolution, or data exposed to students vs. staff — mistakes in these
  areas have real safety and privacy consequences for a school deployment.

## Contributor License Confirmation

By submitting a pull request, you confirm that:

- You wrote the code yourself, or have the right to submit it under this
  project's license (the GNU Affero General Public License v3.0 — see
  [LICENSE](LICENSE)).
- Your contribution does not include code copied from a proprietary,
  closed-source, or incompatibly-licensed source that you don't have the
  right to relicense.
- You're submitting your contribution under the same AGPLv3 license that
  covers the rest of the project.

## What Not to Submit

**Never include any of the following in a contribution, issue, or pull
request — including in code comments, test fixtures, screenshots, or
log output pasted for debugging:**

- Secrets: API keys, passwords, tokens, private certificates, `.env`
  contents, database credentials
- Proprietary or confidential code you don't have rights to share
- Real student data, real staff data, or any other real personally
  identifiable information (PII) — use synthetic/fake data for tests,
  examples, and bug reports, always
- Anything covered by FERPA, COPPA, or your district's confidentiality
  policies

If you accidentally commit something like this, don't just delete it in
a follow-up commit — git history retains it. Contact a maintainer so it
can be properly purged from history, and rotate any exposed credentials
immediately.

## Questions

Open a [GitHub Discussion](../../discussions) or issue if anything here
is unclear, or if you want feedback on an idea before building it out.
