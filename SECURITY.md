# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the Butlr MCP Server, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@butlr.com** with:

- A description of the vulnerability
- Steps to reproduce the issue
- Any relevant logs or screenshots
- Your assessment of the severity

We will acknowledge your report within 48 hours and provide an estimated timeline for a fix.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Best Practices

When using the Butlr MCP Server:

1. **Never commit credentials** to version control. Use environment variables or a secure vault.
2. **Use read-only API scopes** whenever possible. The MCP server only requires read access.
3. **Rotate credentials regularly**, especially if you suspect they may have been exposed.
4. **Restrict network access** to the Butlr API from trusted environments only.
5. **Keep dependencies updated** by running `npm audit` periodically.

## Scope

This security policy covers the `@butlr/butlr-mcp-server` npm package and this GitHub repository. For vulnerabilities in the Butlr platform or APIs, please contact Butlr support directly.
