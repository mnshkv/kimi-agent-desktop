# Security Policy

## Supported versions

Only the latest `main` branch is supported with security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability**, or contact [@mnshkv](https://github.com/mnshkv) directly. You will get a response within 7 days.

## Scope

- This plugin is a local wrapper: it activates software already installed on your machine (Xcode / Android Studio / the agent-desktop CLI) and speaks MCP over stdio to your coding agent.
- It does not ship third-party binaries, does not phone home, and holds no secrets. MCP config files (if any) stay on your machine.
- The covered surface: the manifest, launcher scripts, bundled skills, and documentation in this repository.

## Hardening notes

- Tools are granted to the agent only while a session runs; review the tool list in the README before enabling.
- If you use the JetBrains MCP Server integration (Android Studio plugin), its own security policy applies on top.
