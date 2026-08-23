# InjectionIII benchmark setup

The InjectionIII arm uses the official 5.2.1 release from
<https://github.com/johnno1962/InjectionIII/releases/tag/5.2.1RC5>.

The release archive used for this demo has SHA-256:

```text
37eae7b0b5d47d908232b9e6691e20a5e3fbc346953df3dc180b8531aa2b4e9c
```

Install `InjectionIII.app` in `/Applications`, build the Debug configuration,
and launch the app with `MOOPS_ENABLE_INJECTIONIII=1`. The common fixture loads
`iOSInjection.bundle` only when that environment variable is present. The Debug
configuration emits frontend command lines and links with `-interposable`.

Preflight must prove enablement from the running app log (watcher/bundle load),
not merely from the presence of the `.app` bundle.

The fixed task intentionally requires operations described under “What
injection can't do” in the official README:

- adding stored properties changes in-memory data layout;
- adding a new source file is not handled reliably.

Therefore the expected honest arm-C trace is: InjectionIII is enabled, Codex may
use it for compatible intermediate edits, and the required structural slice
falls back to a normal rebuild. That fallback is the comparison point for MOOPS.

