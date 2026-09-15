# Changesets

Every pull request must commit a changeset. Run `pnpm changeset` for a user-visible change, choose
one package in the Akeru fixed release group, and describe the result in user-facing language. Run
`pnpm changeset --empty` for documentation, tests, refactors, or internal tooling that should not
ship a new product version.

Use `patch` for fixes and compatible refinements, `minor` for new compatible behavior, and `major`
for breaking changes. The four product packages are a fixed release group, so selecting one bumps
all four to the same version.
