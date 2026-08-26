## `day new`

One command scaffolds a working app: a typed-route sidebar over four sample panels, locales, a
dayscript walkthrough, and the thin native host projects each mobile target builds through.

```sh
day new app my-app --toolkit macos-appkit --toolkit linux-gtk
```

Pick the platform-toolkits you want to ship on. You can add more later with:

```sh
day app add-toolkit android-mdc
```

Every question the command asks has an equivalent flag, so the same choices work in a script.
