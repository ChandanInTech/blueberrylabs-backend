# @social-resizer/contracts

Versioned request/response types and the canonical image preset registry shared by
the backend (authoritative) and the frontend (consumer).

## Rules

- The **backend** owns this package. Presets and enums here are authoritative; the
  API validates every request against them.
- The **frontend** consumes a pinned build of this package. It must still treat API
  responses as runtime-untrusted data — `isApiErrorBody`, `isPlatform`, `isFormat`
  and friends exist for exactly that.
- Never import across the `backend/` / `frontend/` submodule boundary with relative
  paths.

## Usage

```ts
import { PRESETS, findPreset, type CreateGenerationRequest } from "@social-resizer/contracts";

const preset = findPreset("INSTAGRAM", "PORTRAIT"); // { width: 1080, height: 1350, ... }
```

## Releasing

```bash
bun run build          # emits dist/ + .d.ts
bun pm pack            # produces social-resizer-contracts-<version>.tgz
```

The parent repo's `scripts/sync-contracts.sh` packs this package and installs the
tarball into `frontend/`, which keeps the two submodules decoupled while still
sharing one source of truth.
