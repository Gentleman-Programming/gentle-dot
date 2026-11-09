# Issue draft — Gentleman-Programming/gentle-ai

## Título

`tui: TestRuntimeCatalogDiscoveryIgnoresStaleProjectResults fails on pristine main`

## Cuerpo

### What

`TestRuntimeCatalogDiscoveryIgnoresStaleProjectResults` (internal/tui/model_test.go) fails on a
pristine checkout of main — no local changes needed to reproduce.

### Reproduce

```sh
git checkout 7d3528877   # Merge pull request #5924 (also fails on later commits)
go test ./internal/tui/ -run TestRuntimeCatalogDiscoveryIgnoresStaleProjectResults -count=1 -v
```

### Observed

```
=== RUN   TestRuntimeCatalogDiscoveryIgnoresStaleProjectResults
    model_test.go:7284: stale result replaced active catalog: [omniroute project-b]
--- FAIL: TestRuntimeCatalogDiscoveryIgnoresStaleProjectResults (0.02s)
FAIL    github.com/gentleman-programming/gentle-ai/v4/internal/tui
```

The assertion at model_test.go:7284 expects the runtime-catalog discovery to ignore a stale
discovery result, but `m.ModelPicker.AvailableIDs` ends up as `[omniroute project-b]` (the stale
result replaced the active catalog).

### Expected

The stale result should be ignored and the test should pass.

### Context

- Verified on a pristine worktree at 7d3528877 (no local modifications).
- Also fails on our integration branch after a clean upstream merge, which is how we noticed.
- Environment: Linux, go version from the repo's toolchain, Node not involved.

### Note

Happy to send a fix — it looks like the staleness check around `RuntimeCatalogDiscoveryMsg`
handling may have regressed with the model-picker discovery work.

---

## Publicado

**Issue #5928**: https://github.com/Gentleman-Programming/gentle-ai/issues/5928 (HTTP 201)

## Checklist usado al publicar

- [ ] Cuenta con acceso a gh (`gh auth status`)
- [ ] Publicar en Gentleman-Programming/gentle-ai (issue-first, sin PR hasta approved)
- [ ] Labels sugeridos: bug, tui
