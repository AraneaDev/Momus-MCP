# Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to version and
changelog the five published packages (`@momus/core`, `@momus/parser-typescript`,
`@momus/parser-php`, `@momus/mcp-server`, `@momus/cli`).

## Adding a change

```bash
npm run changeset        # interactive prompt
# or: npx changeset add
```

Answer the prompts, then commit the generated `.changeset/*.md` file alongside your change.

## How releases work

- Merging a PR that includes a changeset opens a **"Version Packages"** PR (via
  `changesets/action` in `.github/workflows/release.yml`).
- Merging that PR bumps versions, writes `CHANGELOG.md` files, tags `v*`, cuts GitHub
  Releases, and runs `changeset publish` → `npm publish` for the changed packages.

No changeset is needed for docs-only or repo-internal changes (the root `momus-mcp` package
and `packages/action` are not published to npm).
