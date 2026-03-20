# Contributing to Butlr MCP Server

Thank you for your interest in contributing to the Butlr MCP Server!

## Development Setup

### Prerequisites
- Node.js >= 20.0.0
- npm >= 9.0.0

### Getting Started

```bash
# Clone the repository
git clone https://github.com/butlrtechnologies/butlr-mcp.git
cd butlr-mcp

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run dev:debug` | Start with DEBUG=butlr-mcp |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run clean` | Remove build artifacts |
| `npm run rebuild` | Clean and build |
| `npm test` | Run test suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Generate coverage report |
| `npm run typecheck` | Type-check without building |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check code formatting |

## Pre-Commit Hooks

Every commit automatically runs:

1. **Type checking** (`npm run typecheck`) - Ensures TypeScript types are valid
2. **Full test suite** (`npm test`) - All 256 tests must pass (~600ms runtime)
3. **Secret file detection** - Blocks commits containing `.env`, `.pem`, `.key`, `.p12`, `.pfx` files
4. **Secret pattern detection** - Scans for AWS keys, API tokens, JWTs in code
5. **Large file detection** - Blocks files >500KB (suggest Git LFS or .gitignore)
6. **ESLint + Prettier** - Auto-formats staged `.ts` files

### Bypass Hook (Emergency Only)

```bash
git commit --no-verify
```

**Note:** Only use `--no-verify` in emergencies. All PRs must pass CI checks which run the same validations.

## Performance Guardrail

If the test suite exceeds **2 seconds**, we'll move it to a `pre-push` hook to keep commits fast. Currently at ~600ms, well within limits.

## Coding Standards

- **TypeScript strict mode** - All code must type-check
- **No `any` types** - Use proper types or `unknown` with narrowing
- **Test coverage** - New features require tests
- **Deterministic tests** - Tests must pass in any timezone (use explicit TZ in mocks)

## Pull Request Process

1. **Create a feature branch** from `main`
2. **Make your changes** with clear, focused commits
3. **Ensure tests pass** locally before pushing
4. **Update documentation** if adding/changing features
5. **Submit PR** with clear description of changes

## Testing Guidelines

### Unit Tests
- Mock external dependencies (GraphQL, REST APIs)
- Test edge cases and error handling
- Use fixtures for complex API responses

### Integration Tests
- Test tool behavior end-to-end
- Use deterministic test data
- Verify response structure and content

## Questions or Issues?

- **Bugs**: Open an issue on GitHub
- **Features**: Discuss in an issue before implementing
- **Questions**: Ask in discussions or Slack

Thank you for contributing! 🙏
