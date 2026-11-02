# CClip local processing and external services

CClip stores projects, settings, source copies, captions and generated files locally. Local editing, transcription and cover templates run on the device. Generated-video and download folders can be changed in Settings. One-click cleanup removes only verified, inactive application scratch files; it does not empty project, finished-video or download folders.

Cloud analysis, translation and image generation send the relevant text or images to the configured provider and may use paid API credits. Review the scope shown before calling and the provider's own handling rules.

Usage analytics and crash reporting are disabled by default in this edition. Account posting and scheduled publishing are not included. Retained upstream telemetry code and tests do not mean those services are enabled in CClip. A ChatGPT subscription login is not an image API credential for this application.

Never submit credentials, cookies, private media, captions or logs containing personal paths to this public repository. Use synthetic examples and sanitized logs. See [Issues](https://github.com/georgewithtaylor-dev/CClip/issues) and the [security policy](../SECURITY.md).

## Upstream installer compatibility

The source retains the upstream Windows installer; this CClip portable ZIP does not use it. Its data folder is `%APPDATA%\AutoClip`. The uninstaller option “Also delete my AutoClip data (projects, settings, API keys)” and the silent `/DELETEAPPDATA` flag request deletion of that upstream folder. This is separate from CClip project storage and safe scratch cleanup.
