/** Resolve a `use`/`mod` specifier to an absolute path. Conservative (null) until the
 *  crate-wide index (Task 4) provides real cross-file resolution. */
export function resolveRustImport(_specifier: string, _fromFile: string): string | null {
  return null;
}
