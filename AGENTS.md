# CClip contributor instructions

- Read docs/CCLIP_DEVELOPMENT.md and docs/TESTING_ACCEPTANCE.md before changes.
- Preserve source media, project data and secrets. Use isolated test data.
- Run scripts/quality_gate.py and verify affected desktop behaviours before delivery.
- Keep all eight UI locales consistent. Retain the upstream MIT copyright.
- Cleanup may remove only verified, inactive application scratch files. Keep unknown files and filesystem links.
- Never commit user media, transcripts, credentials, local settings, runtime bundles or private evidence.
- macOS Intel and Apple Silicon acceptance is pending. Do not claim it passed or bypass release requirements.
