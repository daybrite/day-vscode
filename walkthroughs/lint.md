## Linting

A Day app has correctness the Rust compiler cannot check. A `tr("greeting")` with no message
compiles and renders the word `greeting`; a permission the code uses but `Day.toml` does not
declare terminates the app on iOS. `day lint` checks that class of thing.

Findings land in the Problems panel with their rule code, and where a repair is safe and
unambiguous it is offered as a quick fix.

- [Linting](https://vscode.daybrite.dev/docs/linting) — the findings, and the fixes
- [Localization](https://daybrite.dev/docs/localization/) · [Navigation](https://daybrite.dev/docs/navigation/)
- [Permissions](https://daybrite.dev/docs/guide-permissions/) — declaring what an app asks for
