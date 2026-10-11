# Releasing

Versions are published by GitHub Actions with **npm trusted publishing**: npm trusts the
workflow `publish.yml` of this repository through OIDC. There is no npm token anywhere, and
every version gets a provenance attestation linking it to the commit it was built from.

## Release a version

1. Bump `version` in `package.json`, add a `## <version> – <date>` section to `CHANGELOG.md`,
   commit and push to `main` (CI must be green).
2. Tag and push the tag:

   ```bash
   git tag -a v0.1.1 -m "@tantchen/fritzbox 0.1.1"
   git push origin v0.1.1
   ```

3. GitHub → **Actions** → run **publish** waits for approval (environment `npm`):
   **Review deployments** → **Approve**.
4. The workflow checks that the tag matches `package.json`, skips versions npm already has, runs
   typecheck, tests and build (`prepublishOnly`) and publishes. The version on npmjs.com shows
   the provenance badge.

## How it is set up

The values on both sides must match the workflow exactly.

### npmjs.com – package `@tantchen/fritzbox` → Settings

| Setting | Value |
|---|---|
| Trusted Publisher | GitHub Actions |
| Organization or user | `tantchen` |
| Repository | `fritzbox` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |
| Publishing access | Require two-factor authentication and disallow tokens |

Tokens are rejected for this package, publishing works only through the workflow or an
interactive login confirmed with the passkey.

### GitHub – repository `tantchen/fritzbox` → Settings → Environments → `npm`

| Setting | Value |
|---|---|
| Required reviewers | `tantchen` (every publish needs an approval) |
| Deployment branches and tags | selected, tag rule `v*` |

### Workflow – `.github/workflows/publish.yml`

- trigger: push of a tag `v*`
- `permissions: id-token: write` (OIDC token for npm), `contents: read`
- `environment: npm`
- third party actions pinned to commit SHAs; when updating them, take the SHA of the release
  tag (`https://api.github.com/repos/<owner>/<action>/git/refs/tags/<tag>`) and keep the
  version as comment

## Manual fallback

`scripts/publish.local.sh` (machine local, git-ignored) publishes from the dev container: web
login confirmed with the passkey, `npm publish`, tag push. npm stages a publish made that way –
the version has to be approved on npmjs.com before it can be installed. Run it in a normal
terminal, npm prints URLs and waits. Version 0.1.0 was published this way, because a trusted
publisher can only be configured for a package that exists already.
