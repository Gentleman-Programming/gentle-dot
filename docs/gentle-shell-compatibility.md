# Gentle Shell profile compatibility

Gentle Dot preserves Gentle Shell 4.7 profile workflow metadata when managing model profiles. This is format compatibility, not a new UI control or permission to enable a delegation mode.

## Stored profiles

Gentle Shell keeps its version-1 profile format and may add:

```json
{
  "workflow": {
    "delegated": { "orchestratorMode": "full-delegation" }
  }
}
```

The name must identify a stored profile. Like the engine, Dot omits the default `organic` mode, invalid modes, and orphan workflow entries. Existing organic-only stores retain their previous shape.

Saving routes or applying another profile preserves existing workflow entries. Renaming or duplicating a profile carries its workflow metadata; deleting it removes that profile's entry. An import with identical routes but a different workflow mode is not an identical profile: it receives the normal collision suffix. Repeating that import does not duplicate it again or alter the source store.

## Verification boundaries

Tests exercise synthetic profile files through the public profile store and format functions. They never migrate real user data or invoke a model. Windows POSIX mode-bit assertions must be distinguished from this format change using the unmodified base; they must not be skipped, weakened, or presented as passing.

Dependency resolution, candidate runtime packaging, the pinned Gentle AI helper, and independent verification remain separate checks. A dependency version change alone does not establish runtime compatibility.
