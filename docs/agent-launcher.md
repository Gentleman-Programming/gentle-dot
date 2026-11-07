# Selecting the assistant launcher

The default is the bundled Gentle Shell, with the assistant's separate home.
To select a different Gentle Shell script without giving up that home, set
`GENTLE_DOT_AGENT_SCRIPT`:

```powershell
$env:GENTLE_DOT_AGENT_SCRIPT = 'C:\Program Files\Gentle Dot\gentle-shell.mjs'
```

Launcher selection follows this order:

| Priority | Setting | Arguments and assistant home |
| --- | --- | --- |
| 1 | Nonempty `GENTLE_DOT_AGENT_ARGS` | JSON argument array; no Gentle Shell home, even when SCRIPT or HOME is also set. |
| 2 | Nonempty `GENTLE_DOT_AGENT_SCRIPT` | Script path passed unchanged as one argument; separate home retained. |
| 3 | `GENTLE_DOT_AGENT_BIN` without SCRIPT | Explicit command with no arguments; separate home retained. |
| 4 | Defaults | Bundled Gentle Shell script; separate home retained. |

For SCRIPT or ARGS, the command is `GENTLE_DOT_AGENT_BIN` when supplied,
otherwise the daemon's Node executable. With SCRIPT, an explicit BIN must accept
that script argument, as Node does. Spaces do not require extra quotes inside
the variable's value. An empty SCRIPT is treated as absent. Malformed ARGS still
rejects configuration rather than falling back to SCRIPT.

The separate home defaults to `<dataDir>/agent`; `GENTLE_DOT_AGENT_HOME` overrides
it. Selecting a script does not validate its existence, execute it during
configuration loading, or normalize the supplied path. Installed runtime
selection, the Go launcher and child-environment sanitization are unchanged.
