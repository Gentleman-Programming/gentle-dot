# Voice-model download integrity

Local Parakeet downloads verify the expected size and SHA-256 before installing the model. This protects against truncated transfers and unexpected release contents on every platform, including Windows.

If the application reports:

> The download was not the expected size.

an older build may pin an earlier asset published under the same download URL. Use a build with the verified release pins below, then retry the application's normal model-download action. Do not disable integrity checks, weaken TLS validation, or delete an existing model as a workaround.

## Verified release asset

- [Official Sherpa-ONNX Parakeet v3 int8 archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2)
- Compressed size: **487,211,443 bytes**.
- SHA-256: `1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9`.
- Archive root: `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`.
- Required model files: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt`.

The archive was downloaded into an isolated validation cache and checked in full against the published size and digest, including its layout and required files. No live application profile was used.

If the upstream asset changes again, a mismatch must still reject the download. Maintainers should independently validate the replacement archive before changing both pins; do not accept a new size or checksum merely to silence an error.
