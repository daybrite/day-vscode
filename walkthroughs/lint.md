## `day lint`

Checks the things a compiler cannot: Fluent message coverage across locales, duplicate element ids,
routes nothing declares, permissions used but not declared, and store-listing rules.

Findings appear in the Problems panel on the lines they name. Where the repair is safe and
unambiguous, it is offered as a quick fix — `⌘.` on the squiggle, or **Fix all in file**.

From a terminal, `day lint --fix` applies the same repairs.
