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
  hasConfig: boolean;
}

const cache = new Map<string, ProgramHandle>();
/**
 * Declaration files (`lib.*.d.ts`, `node_modules/@types/**`) parsed once and shared by every
 * program. Without this each tsconfig-less directory got its own program holding a private copy
 * of the DOM lib and every `@types` package, which exhausted the heap on mid-sized repositories
 * (issue #56). Sharing parsed source files across programs is what TypeScript's own
 * DocumentRegistry does; the key includes the parse options so differing targets never collide.
 */
const sharedDeclarations = new Map<string, ts.SourceFile>();

export function getProgram(fromFile: string): ProgramHandle {
  let dir = dirname(fromFile);
  let configPath: string | undefined;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
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
      for (const f of ts.sys.readDirectory(
        d,
        ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs'],
        undefined,
        undefined,
      )) {
        files.push(f);
      }
    }
  }
  if (files.length === 0) files.push(fromFile);

  const options = configPath
    ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!
        .options
    : {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      };
  // Without a tsconfig nothing asked for ambient `@types`; including every installed package
  // per directory is what made config-less programs expensive. Imports still resolve normally.
  const programOptions: ts.CompilerOptions = configPath ? options : { ...options, types: [] };

  const parsed = new Map<string, ts.SourceFile>();
  const host = ts.createCompilerHost(options, true);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = ts.sys.resolvePath ? ts.sys.resolvePath(fileName) : fileName;
    const hitSf = parsed.get(key);
    if (hitSf) return hitSf;
    const isDeclaration = /\.d\.[cm]?ts$/.test(key);
    const sharedKey = isDeclaration ? `${key}\u0000${parseOptionsKey(languageVersion)}` : undefined;
    const sharedSf = sharedKey ? sharedDeclarations.get(sharedKey) : undefined;
    if (sharedSf) {
      parsed.set(key, sharedSf);
      return sharedSf;
    }
    const text = ts.sys.readFile(key);
    const sf =
      text !== undefined
        ? ts.createSourceFile(key, text, languageVersion, true)
        : orig(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (sf) {
      parsed.set(key, sf);
      if (sharedKey) sharedDeclarations.set(sharedKey, sf);
    }
    return sf;
  };

  const program = ts.createProgram(files, programOptions, host);
  const handle = { program, options, rootDir, hasConfig: configPath !== undefined };
  cache.set(rootDir, handle);
  return handle;
}

/** Clear the memoized program cache so watch-mode audits reflect on-disk changes. */
export function invalidateProgramCache(): void {
  cache.clear();
  sharedDeclarations.clear();
}

function parseOptionsKey(v: ts.ScriptTarget | ts.CreateSourceFileOptions): string {
  if (typeof v !== 'object') return String(v);
  return `${v.languageVersion}:${v.impliedNodeFormat ?? ''}:${v.jsDocParsingMode ?? ''}`;
}

export function resolveImport(specifier: string, fromFile: string): string | null {
  const { options } = getProgram(fromFile);
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
  const cls = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === name) as
    ts.ClassDeclaration | undefined;
  if (!cls) return undefined;
  const method = cls.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText(sf) === methodName) as
    ts.MethodDeclaration | undefined;
  if (!method) return undefined;
  const sig = checker.getSignatureFromDeclaration(method);
  if (!sig) return undefined;
  return { params: [...sig.parameters], returnType: checker.getReturnTypeOfSignature(sig), checker };
}

export function unwrapPromise(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  const promised = (
    checker as unknown as { getPromisedTypeOfPromise?(t: ts.Type): ts.Type | undefined }
  ).getPromisedTypeOfPromise?.(type);
  return promised ?? type;
}

function splitId(id: string): [string | undefined, string | undefined] {
  const idx = id.lastIndexOf('#');
  if (idx <= 0) return [undefined, undefined];
  return [id.slice(0, idx), id.slice(idx + 1)];
}
