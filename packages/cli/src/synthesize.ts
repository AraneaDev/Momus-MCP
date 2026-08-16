/** Contract synthesis for `momus contract` — delegates to the server's TS+PHP implementation. */
import { synthesizeContract } from '@momus/mcp-server';

export function synthesizeForCli(
  root: string,
  targetPath: string,
  symbolName: string | undefined,
  framework: string,
): { template: string } | { error: string } {
  const out = synthesizeContract(root, targetPath, symbolName, framework, true);
  if ('error' in out) return { error: out.error };
  return { template: out.template };
}
