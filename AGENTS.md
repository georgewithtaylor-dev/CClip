# CClip contributor instructions

- Read docs/CCLIP_DEVELOPMENT.md and docs/TESTING_ACCEPTANCE.md before changes.
- Preserve source media, project data and secrets. Use isolated test data.
- Run scripts/quality_gate.py and verify affected desktop behaviours before delivery.
- Keep all eight UI locales consistent. Retain the upstream MIT copyright.
- Cleanup may remove only verified, inactive application scratch files. Keep unknown files and filesystem links.
- Never commit user media, transcripts, credentials, local settings, runtime bundles or private evidence.
- CClip currently supports Windows x64 portable only. Read docs/CCLIP_RELEASE.md for the maintainer-authorized Windows-only release scope; do not apply the retained upstream multi-platform release workflow to that package. Mac acceptance has not passed.
- Publish only an actually verified ZIP with its exact source SHA and checksum. Never overwrite a published tag or include private data.
