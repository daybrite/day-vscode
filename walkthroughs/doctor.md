## `day doctor`

Every target needs its own toolchain: Xcode for Apple platforms, a JDK and the Android SDK for
`android-mdc`, GTK 4.10 or Qt 6 for the Linux desktops.

`day doctor` checks them all and, for anything missing, prints the command that installs it. Each
probe says what its absence blocks — a build, packaging, or only launching — so a warning does not
read like an error.

Point it at one toolkit with `day doctor --toolkit gtk`, which also prints that toolkit's full
setup notes.
