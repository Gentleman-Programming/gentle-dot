# Gentle Dot daemon

## Explicit Windows addon build

On Windows, use an **existing** MSVC/Windows SDK developer environment with
`INCLUDE` and `LIB` configured for the same architecture as Node. Supply matching
Node headers, architecture/version-compatible `node.lib`, and the compiler path.
The build script does not install or download inputs, use node-gyp, or add dependencies.

```powershell
# From packages/daemon; substitute your existing absolute input paths.
node scripts/build-windows-stop.mjs --help
node scripts/build-windows-stop.mjs --compiler "C:\existing\cl.exe" --headers "C:\existing\node\include\node" --node-lib "C:\existing\node.lib"
```

The package command is `pnpm run build:windows-stop -- <same arguments>`.
The compiler emits `native/windows-stop.node` and local compiler/linker artifacts.
It must not be cross-built with mismatched Node/import-library architecture.
Source execution loads `packages/daemon/native/windows-stop.node`.
The addon exports the app channel (`adoptAppChannelFd3`) and the stop listener
(`createStopListener`); runtime staging is not included yet. Windows CI provisions
matching build inputs explicitly.
