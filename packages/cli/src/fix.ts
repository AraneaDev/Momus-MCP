/**
 * The fix mechanics moved to @momus/core so the MCP server can share them without importing
 * the CLI (which would close a package cycle: @momus/cli already depends on
 * @momus/mcp-server). Re-exported here so the CLI's imports and tests are unchanged.
 */
export {
  collectFixable,
  editsByFile,
  applyFixes,
  unifiedDiff,
  buildFixDiff,
  applyFixToFiles,
  type FixableIssue,
} from '@momus/core';
