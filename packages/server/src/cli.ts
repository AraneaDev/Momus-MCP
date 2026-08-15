#!/usr/bin/env node
/** `momus-mcp` binary: stdio MCP server (spec docs/04 §4.1). */
import { serve } from './index.ts';

const root = process.env.MOMUS_ROOT ?? process.cwd();
serve({ root }).catch((e) => {
  process.stderr.write(`momus-mcp: fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
