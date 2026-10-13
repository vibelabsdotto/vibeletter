# VibeLetter CLI

Context-aware operator CLI for a self-hosted VibeLetter instance. Requires Node.js 24 or later.

```sh
npm run build --workspace @vibelabsdotto/vibeletter-cli
node apps/cli/dist/index.js --help
npm run cli --workspace @vibelabsdotto/vibeletter-cli -- --help
```

The executable is `vibeletter`. Full command help, context configuration, CSV workflows, and HTTP mappings are in [docs/CLI.md](../../docs/CLI.md) in the source repository.

Tokens enter through `VIBELETTER_TOKEN`, a private token file, or stdin. There is no token argument. Configuration and exported files are written atomically with mode 0600.
