# Runtime report screen retired

The runtime diagnostic screen and its Settings launcher have been retired from source, together with the report request/reply path and `/diagnostics` command. There is no replacement report screen or command.

Chat, the composer, ordinary Settings, voice device checks and existing account/profile/connector screens remain. The optional debug preference and private RDD/Discord capture have also been retired from source. Existing stored settings, captures, logs and audit records remain untouched.

Node state tests exercise ordinary navigation, connection transitions and notices. Structural checks guard removal of report routing, timeout/focus plumbing and report-specific composer hiding; they are not rendered scroll, focus, keyboard, clipboard or Windows acceptance evidence.

The owner compiles and controls delivery. This source change does not authorize a build, installation, restart, runtime cleanup or environment replacement.
