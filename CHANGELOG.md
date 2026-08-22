# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## New features

- **Configurable classifier request timeout** — new `autoMode.classifierTimeoutMs` setting. The default is 20000 ms. The timeout applies to each classifier request. The fast stage and the detailed stage each have their own budget. A request that exceeds the timeout is aborted. Auto mode fails closed and blocks the action.
- **Read-only agent diagnostics** — Add `automode_inspect` tool for status, configuration, defaults, and recent denial metadata. Thank you, @blalor! (#11)

## Bug fixes

- **In-memory observability logs** — Write logs to an extension-owned directory (`~/.pi/agent/extensions/pi-automode/logs/`) instead of the launching project directory. Thanks, @HerbertGao! (#13)
