# Releasing ratelimitly-express

Releases are built from an exact `v<package-version>` tag by
`.github/workflows/release.yml`. The workflow installs from the lockfile, runs
the complete tests, tests the packed consumer, audits production dependencies,
packs one artifact, and publishes that artifact with npm provenance.

Do not publish from an uncommitted working tree, reuse a version, move a release
tag, or create the GitHub release before npm publication succeeds.

## Prepare a release

1. Update `package.json` and `package-lock.json` to the intended version.
2. Move completed entries from `[Unreleased]` to a dated changelog section.
3. Open a focused pull request and run `npm ci`, `npm test`,
   `npm run test:package`, and `npm audit --omit=dev`.
4. Merge only after required CI passes, then verify the exact `main` workflow.
5. Confirm that `npm view ratelimitly-express@<version>` does not already
   exist.

Create an annotated tag on the verified `main` commit and push it:

```sh
git fetch origin
git switch main
git merge --ff-only origin/main
git tag -a v1.0.0 -m 'ratelimitly-express 1.0.0'
git push origin v1.0.0
```

The tag must equal `v` followed by the version in `package.json`. The workflow
fails before publishing when they differ. If the version is already present on
npm, the workflow succeeds only when the registry integrity exactly matches the
artifact packed from the tag.

After the workflow succeeds, verify the registry package from a clean temporary
consumer and create the GitHub release from the existing tag.

## Bootstrap the first publication

npm requires a package to exist before a trusted publisher can be attached.
For version 1.0.0 only, create a short-lived granular npm token with read/write
package permission and **Bypass 2FA** enabled, save it as the repository Actions
secret `NPM_TOKEN`, and then push `v1.0.0`.

The release workflow uses `NPM_TOKEN` only when that secret exists. GitHub OIDC
is still enabled and `npm publish --provenance` records the public source and
workflow for the initial artifact.

Immediately after 1.0.0 exists:

1. configure the npm trusted publisher for GitHub organization
   `ratelimitly-com`, repository `rl-express`, and workflow file `release.yml`;
2. allow `npm publish` for that publisher;
3. delete the GitHub `NPM_TOKEN` secret;
4. revoke the granular bootstrap token on npm; and
5. set package publishing access to require two-factor authentication and
   disallow traditional tokens.

With npm 11.15.0 or newer and an interactive npm login, the trusted publisher
can also be configured from the command line:

```sh
npm trust github ratelimitly-express \
  --repo ratelimitly-com/rl-express \
  --file release.yml \
  --allow-publish
```

Do not retain a bootstrap token as a fallback. With no `NPM_TOKEN` secret, npm
uses the workflow's short-lived OIDC identity and automatically generates
provenance for later releases.

## Verify a published release

Check the registry metadata and install the released artifact into an empty
directory rather than relying on the repository's existing dependencies:

```sh
npm view ratelimitly-express@1.0.0 name version dist.integrity repository
mkdir /tmp/ratelimitly-express-consumer
cd /tmp/ratelimitly-express-consumer
npm init -y
npm install --ignore-scripts ratelimitly-express@1.0.0 express@4
node -e "const rl = require('ratelimitly-express'); if (typeof rl !== 'function') process.exit(1)"
```

Then create the GitHub release:

```sh
gh release create v1.0.0 \
  --repo ratelimitly-com/rl-express \
  --verify-tag \
  --title 'ratelimitly-express 1.0.0' \
  --notes-from-tag
```
