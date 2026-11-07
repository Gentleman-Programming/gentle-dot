# Spanish answer and PIN controls

T7 uses the existing UI locale for authored AskCard controls, PIN field labels,
help, local validation messages, and the ChatSurface PIN dialog. English remains
the default, with the original wording and DOM structure.

Supplied question titles, details, options, placeholders and input remain verbatim.
Connector names and IDs are inserted verbatim into localized confirmations;
commands, arguments, PINs, generated prompts and backend errors are not translated.
`describePinCommand` stays pure, defaults to English and accepts an explicit
translator as its optional third argument.

The confirmation still names the real action: connect, disconnect, remove,
change read permissions, add the drafted connector, or import a server count.
No validation condition, password masking, permission guard, or submit sequence
changes. The existing locked-PIN notice remains informational in the renderer;
the server remains responsible for enforcing the lock.

Synthetic renderer tests cover invalid PIN lengths/characters and mismatches
sending nothing, retained input/storage/state, accepted 6/12-digit boundaries,
first-use PIN creation order, existing-PIN approval, denial, cancellation,
verbatim question data and exact outgoing messages. Existing English component,
PIN and conversation-switch tests run alongside these checks. No actual server,
PIN authentication, native dialog or Windows acceptance is exercised here;
parent-owned LSP, browser and integration verification remain separate.
