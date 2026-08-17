import type { ImportIR } from '@momus/core';
import type { RustFile, RustItem } from './ast.ts';

export function extractImports(file: RustFile): ImportIR[] {
  const out: ImportIR[] = [];
  const walk = (items: RustItem[]): void => {
    for (const item of items) {
      if (item.kind === 'use') {
        const local = item.alias ?? item.path.split('::').pop() ?? item.path;
        out.push({ specifier: item.path, names: item.glob ? [] : [local] });
      } else if (item.kind === 'mod') {
        walk(item.items);
      }
    }
  };
  walk(file.items);
  return out;
}
