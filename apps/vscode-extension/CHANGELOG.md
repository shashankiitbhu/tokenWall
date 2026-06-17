# Changelog

All notable changes to the "tokenwall-vscode" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.10] - 2026-06-17

### Added
- **CacheAligner**: Normalizes whitespaces and detects volatile system prompt prefixes (e.g., dynamic UUIDs, JWTs, hashes, and timestamps) to prevent caching fragmentation.
- **Anthropic Ephemeral Caching Control**: Automatically injects caching breakpoints on long contexts, system instructions, and tool definitions to secure Anthropic's 90% cache read discount.
- **Auto-Optimize Interception Bypass**: Fast-tracks prompts with purely optimize-only context inefficiencies directly to compression without requiring interactive user approvals.

## [1.0.0] - 2026-06-07

### Added
- Initial release of TokenWall VS Code Extension.
- Local gateway daemon integration.
- Real-time cost observability and tracking via the Status Bar.
- Native VS Code `QuickPick` interception UI for cost approvals and model routing.
- Auto-configuration of third-party AI extensions (Claude Code, Cline, Roo Cline).
- Advanced prompt optimization and token-waste detection.
- Runaway loop prevention built-in.
