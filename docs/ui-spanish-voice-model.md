# Local voice model controls in Spanish

`VoiceModelEntry` now uses the existing UI locale for its title, engine summaries,
chips, download/remove/cancel controls, progress accessibility name and help.
Default English, model names (`NVIDIA Parakeet`, `Parakeet`, `macOS`), byte sizes
and native state values remain unchanged.

## Ownership boundary

Only a failed event **without a message** produces the localized download fallback.
A private discriminated notice state marks that owned origin explicitly. Supplied
messages, including English collisions and empty strings, remain raw. Rejected
operations retain their existing string conversion; no English matching determines
ownership. A locale switch updates authored notices without fetching status again
or replacing the native event subscription.

The component still calls the same status, download, cancel, remove and event
helpers. Progress calculations, installed/unavailable action guards, refreshes,
listener cleanup and storage/audio behavior are unchanged. `ConnectorsPanel` is
the production consumer; there is no new public helper or prop contract.

## Evidence and remaining work

Synthetic tests cover both locales, exact zero-argument operation callbacks,
download/verifying/installed/removed transitions, resumed progress, failed status,
raw event/rejection errors and preferences remaining unchanged. Existing English
`voice-model.test.tsx` tests are preserved, including desktop Connectors gating.
No model is actually downloaded and no native service or device is contacted.

This closes only the **model display** slice of T6. Diagnostic/runtime/native,
`useVoice` and output producers remain later sequential provenance work. It does
not establish complete T6/F2c, browser acceptance, Windows behavior or global typing.
