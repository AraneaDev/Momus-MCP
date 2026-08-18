/** Python parser plugin: tree-sitter AST -> language-neutral Momus IR (mocks/assertions land in later tasks). */
import type { ImportIR, LanguageParser, MockFramework, ModuleIR, ParseContext } from '@momus/core';
import { parsePython, childField, textOf, walk, type SyntaxNode } from './tree.ts';
import { extractSymbols } from './symbols.ts';
import { extractMocks } from './mocks.ts';
import { extractAssertions, extractTestFunctions } from './assertions.ts';
import { resolvePythonImport } from './resolve.ts';
import { getInferredReturnTypes } from './pyright.ts';

export class PythonParser implements LanguageParser {
  readonly language = 'python' as const;

  canParse(path: string): boolean {
    return /\.py$/i.test(path);
  }

  resolveImport(specifier: string, fromFile: string): string | null {
    return resolvePythonImport(specifier, fromFile);
  }

  parseModule(path: string, source: string, _ctx: ParseContext): ModuleIR {
    try {
      const { root, hasError } = parsePython(source);
      const isTest = isTestFile(path);
      // Only production symbols feed the drift rules, and inference shells out to pyright
      // (expensive), so it is skipped for test files and degrades to annotations-only on failure.
      const inferred = isTest ? undefined : getInferredReturnTypes(path);
      const symbols = extractSymbols(root, path, inferred);
      const mockState = extractMocks(root, path, symbols);
      const imports = extractImports(root, path);
      const assertions = extractAssertions(root, path, mockState);
      const functions = extractTestFunctions(root, path, imports, mockState);
      return {
        path,
        language: 'python',
        kind: isTest ? 'test' : 'production',
        framework: isTest ? detectFramework(source) : undefined,
        imports,
        symbols,
        // Module attributes include top-level import bindings (`import idna` binds `idna`;
        // `from x import y` binds `y`) — DRIFT-005 checks `patch('mod.attr')` against this
        // list, so imported names must be present (requests dogfood: `requests.help.idna`
        // and `requests.utils.proxy_bypass` were false-flagged before this).
        exports: [...new Set([...symbols.map((s) => s.name), ...imports.flatMap((i) => i.names)])],
        mocks: mockState.mocks,
        assertions,
        functions,
        comments: [],
        diagnostics: hasError
          ? [
              {
                severity: 'warning',
                span: { file: path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                message: 'SYS-001: Python syntax error (recovered)',
              },
            ]
          : [],
        hash: '',
      };
    } catch (error) {
      return {
        path,
        language: 'python',
        kind: 'production',
        framework: undefined,
        imports: [],
        symbols: [],
        exports: [],
        mocks: [],
        assertions: [],
        functions: [],
        comments: [],
        diagnostics: [
          {
            severity: 'error',
            span: { file: path, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            message: `SYS-001: Python parse error: ${(error as Error).message}`.slice(0, 120),
          },
        ],
        hash: '',
      };
    }
  }
}

function isTestFile(path: string): boolean {
  return (
    /(?:^|[\\/])test_[^\\/]*\.py$/i.test(path) ||
    /(?:^|[\\/])[^\\/]*_test\.py$/i.test(path) ||
    /(?:^|[\\/])tests[\\/]/i.test(path)
  );
}

function detectFramework(source: string): MockFramework {
  return /\bpytest\b|\bmocker\b|\bmonkeypatch\b/.test(source) ? 'pytest' : 'unittest';
}

function extractImports(root: SyntaxNode, file: string): ImportIR[] {
  const imports: ImportIR[] = [];
  walk(root, (node) => {
    if (!node.isNamed) return;
    // Only module-level imports bind module attributes; function/class-local imports shadow
    // locally and must not appear in `exports` (DRIFT-005 attribute checks) or MOCK-001 deps.
    if (node.parent !== root) return;
    if (node.type === 'import_statement') imports.push(...importStatement(node, file));
    else if (node.type === 'import_from_statement') imports.push(importFrom(node, file));
  });
  return imports;
}

function importStatement(node: SyntaxNode, file: string): ImportIR[] {
  const out: ImportIR[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'import') continue;
    const spec = moduleText(child);
    if (!spec) continue;
    // `import a.b.c` binds the topmost name `a` (not `c`) — the module attribute is `a`.
    const local = localName(child) ?? spec.split('.')[0] ?? spec;
    out.push({ specifier: spec, names: [local], resolvedPath: resolvePythonImport(spec, file) ?? undefined });
  }
  return out;
}

function importFrom(node: SyntaxNode, file: string): ImportIR {
  const modNode = childField(node, 'module_name');
  const mod = modNode ? textOf(modNode).replace(/^\.+/, '') : '';
  const names: string[] = [];
  for (const child of node.namedChildren) {
    // Compare by node `id`, not `===` (tree-sitter `childForFieldName` returns fresh wrappers).
    if (child.type === 'from' || child.type === 'import' || (modNode && child.id === modNode.id)) continue;
    const local = localName(child) ?? moduleText(child) ?? '';
    if (local) names.push(local);
  }
  return { specifier: mod, names, resolvedPath: mod ? (resolvePythonImport(mod, file) ?? undefined) : undefined };
}

/** The dotted module path of a `dotted_name` node (or the name inside an `aliased_import`). */
function moduleText(node: SyntaxNode): string | null {
  if (node.type === 'dotted_name') return textOf(node);
  if (node.type === 'aliased_import') {
    const name = childField(node, 'name');
    return name ? textOf(name) : null;
  }
  return null;
}

/** The local name a `dotted_name`/`aliased_import` binds (the alias when present). */
function localName(node: SyntaxNode): string | null {
  // `import a.b.c` binds the topmost name `a` (Python semantics); a single-segment
  // dotted_name (the only valid form inside `from … import`) is unaffected.
  if (node.type === 'dotted_name') return textOf(node).split('.')[0] ?? null;
  if (node.type === 'aliased_import') {
    const alias = childField(node, 'alias');
    return alias ? textOf(alias) : null;
  }
  return null;
}
