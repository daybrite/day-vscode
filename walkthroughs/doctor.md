## Checking toolchains

Every platform needs its own SDK, and the first build on a new machine is where you find out which
one you lack. `day doctor` checks them all and prints the command that installs whatever is
missing.

Only a missing *build* prerequisite is an error. A warning means a toolkit you are not building
today is not fully set up.

- [System requirements](https://daybrite.dev/docs/system-requirements/) — the full list per platform
- [Platforms](https://daybrite.dev/docs/platforms/) — what each target expects
- [Troubleshooting](https://vscode.daybrite.dev/docs/troubleshooting) — when a build fails on a toolchain
