# Example DSH profile

`dsh.profile.bundles` lists `@deepseek-ai/dsh-base` then `dsh-assistant`. The overlay `cordis.patch.yml` is empty: product insertion lives in the assistant bundle patch.

This directory is a repo example. It is not included in the npm pack. `npm test` loads the same bundle list through `@deepseek-ai/dsh-app-boot` (`loadProfile`, `renderConfigDump`, `boot`) — the same composition `dsh --profile assistant --dump-config` uses. See `docs/packaging.md`.
