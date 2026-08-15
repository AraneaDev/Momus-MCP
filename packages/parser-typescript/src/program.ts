/**
 * TypeScript program built over a custom host whose source files carry parent
 * pointers (validated: default program files have no `node.parent`, and checker
 * queries require the program's own file instances — docs/09 F5/F6).
 */
import * as ts from 'typescript';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

interface ProgramHandle {
  program: ts.Program;
  options: ts.CompilerOptions;
  rootDir: string;
}

const cache = new Map<string, ProgramHandle>();

export function getProgram(fromFile: string): ProgramHandle {
  let dir = dirname(fromFile);
  let configPath: string | undefined;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) { configPath = candidate; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const rootDir = configPath ? dirname(configPath) : dirname(fromFile);
  const hit = cache.get(rootDir);
  if (hit) return hit;

  const files: string[] = [];
  for (const sub of ['src', 'tests', 'test', '__tests__', 'lib']) {
    const d = join(rootDir, sub);
    if (existsSync(d)) {
      for (const f of ts.sys.readDirectory(d, ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs'], undefined, undefined)) {
        files.push(f);
      }
    }
  }
  if (files.length === 0) files.push(fromFile);

  const options = configPath
    ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!.options
    : { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };

  const parsed = new Map<string, ts.SourceFile>();
  const host = ts.createCompilerHost(options, true);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = ts.sys.resolvePath ? ts.sys.resolvePath(fileName) : fileName;
    const hitSf = parsed.get(key);
    if (hitSf) return hitSf;
    const text = ts.sys.readFile(key);
    const sf = text !== undefined
      ? ts.createSourceFile(key, text, languageVersion as ts.ScriptTarget, true)
      : orig(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (sf) parsed.set(key, sf);
    return sf;
  };

  const program = ts.createProgram(files, options, host);
  const handle = { program, options, rootDir };
  cache.set(rootDir, handle);
  return handle;
}

export function resolveImport(specifier: string, fromFile: string): string | null {
  const { program, options } = getProgram(fromFile);
  const resolved = ts.resolveModuleName(specifier, fromFile, options, ts.sys).resolvedModule;
  return resolved?.resolvedFileName ?? null;
}

/** Resolve the symbol id (`${file}#${name}`) of an expression's type, if it's a class/interface. */
export function symbolIdOfType(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const sym = type.getSymbol() ?? type.aliasSymbol;
  if (!sym) return undefined;
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl) return undefined;
  const sf = decl.getSourceFile();
  if (sf.fileName.includes('node_modules')) return undefined; // external types: not indexed
  const name = sym.getName();
  return `${sf.fileName}#${name}`;
}

export function classMethodSignature(
  handle: ProgramHandle,
  symbolId: string,
  methodName: string,
): { params: ts.Symbol[]; returnType: ts.Type; checker: ts.TypeChecker } | undefined {
  const [file, name] = splitId(symbolId);
  if (!file || !name) return undefined;
  const sf = handle.program.getSourceFile(file);
  if (!sf) return undefined;
  const checker = handle.program.getTypeChecker();
  const cls = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === name) as ts.ClassDeclaration | undefined;
  if (!cls) return undefined;
  const method = cls.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText(sf) === methodName) as ts.MethodDeclaration | undefined;
  if (!method) return undefined;
  const sig = checker.getSignatureFromDeclaration(method);
  if (!sig) return undefined;
  return { params: [...sig.parameters], returnType: checker.getReturnTypeOfSignature(sig), checker };
}

export function unwrapPromise(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  const promised = (checker as unknown as { getPromisedTypeOfPromise?(t: ts.Type): ts.Type | undefined })
    .getPromisedTypeOfPromise?.(type);
  return promised ?? type;
}

function splitId(id: string): [string | undefined, string | undefined] {
  const idx = id.lastIndexOf('#');
  if (idx <= 0) return [undefined, undefined];
  return [id.slice(0, idx), id.slice(idx + 1)];
}
