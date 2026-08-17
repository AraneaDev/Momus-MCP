/** Mock contract & drift rules (spec docs/03 §3.3.2). */
import { resolve } from 'node:path';
import type { Issue, ModuleIR, MockIR, ParamIR, RuleId, Severity, SourceSpan, StubbedMemberIR, TypeIR } from '../ir.ts';
import type { SymbolIndex } from '../symbolIndex.ts';
import type { Rule, RuleContext } from './engine.ts';

abstract class DriftRule implements Rule {
  abstract readonly id: RuleId;
  abstract readonly name: string;
  abstract readonly defaultSeverity: Severity;
  abstract readonly description: string;
  appliesTo(m: ModuleIR): boolean {
    return m.kind === 'test';
  }
  abstract check(ctx: RuleContext): Issue[];
}

/** In git-diff mode, only mocks whose resolved target changed are in scope. */
function diffRelevant(ctx: RuleContext, mock: MockIR): boolean {
  if (!ctx.diff) return true;
  if (mock.target?.symbolId) return ctx.diff.changedSymbolIds.has(mock.target.symbolId);
  // Module-target mocks (vi.mock/jest.mock factories, automocks) have no symbolId — resolve
  // relevance through the changed module path so a renamed/removed export is still checked in
  // diff/precommit mode (DRIFT-005 missing-export, DRIFT-006 stale-mock).
  if (mock.target?.kind === 'module' && mock.target.modulePath) {
    return ctx.diff.changedPaths.some((p) => resolve(p) === mock.target!.modulePath);
  }
  return false;
}

/** True when the mock's own file changed (author already touched it). */
function mockFileChanged(ctx: RuleContext, mock: MockIR): boolean {
  if (!ctx.diff) return false;
  return ctx.diff.changedPaths.some((p) => p === mock.span.file || resolve(p) === mock.span.file);
}

const issue = (
  ctx: RuleContext,
  rule: RuleId,
  severity: Severity,
  span: { file: string; startLine: number; startCol: number; endLine: number; endCol: number },
  message: string,
  fix?: { code: string; description: string; span?: SourceSpan },
): Issue => ({
  id: `${rule}:${span.file}:${span.startLine}:${span.startCol}:${message.slice(0, 24)}`,
  rule,
  severity,
  span,
  message: message.slice(0, 80),
  fix: fix ? { kind: 'replace', span: fix.span, code: fix.code, description: fix.description.slice(0, 60) } : undefined,
  tokens: 0,
});

/** A real, mechanically-applicable rename fix only when the stub is an unambiguous near-typo. */
function renameFix(
  stub: StubbedMemberIR,
  members: string[],
): { code: string; description: string; span: SourceSpan } | undefined {
  if (
    stub.api !== 'spyOn' &&
    stub.api !== 'shouldReceive' &&
    stub.api !== 'objectLiteralKey' &&
    stub.api !== 'mockFactoryKey'
  ) {
    return undefined;
  }
  const candidates = members.filter((name) => {
    const distance = levenshtein(stub.name, name);
    return distance > 0 && distance <= 2;
  });
  if (candidates.length !== 1) return undefined;
  const target = candidates[0]!;
  const code = stub.api === 'objectLiteralKey' || stub.api === 'mockFactoryKey' ? target : `'${target}'`;
  return { code, description: `rename stub to ${target}`, span: stub.span };
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

export class Drift000UnresolvableTarget extends DriftRule {
  readonly id = 'DRIFT-000' as const;
  readonly name = 'unresolvable-mock-target';
  readonly defaultSeverity = 'info' as const;
  readonly description = 'mock target could not be resolved to a production symbol';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (!m.target || m.target.kind === 'unknown') {
        out.push(
          issue(
            { module } as RuleContext,
            this.id,
            this.defaultSeverity,
            m.span,
            `unresolvable-mock-target: cannot resolve '${m.target?.specifier ?? 'dynamic'}'; checks skipped`,
          ),
        );
      }
    }
    return out;
  }
}

export class Drift001MissingMember extends DriftRule {
  readonly id = 'DRIFT-001' as const;
  readonly name = 'missing-member';
  readonly defaultSeverity = 'error' as const;
  readonly description = 'stubbed member does not exist on the production target';
  check(ctx: RuleContext): Issue[] {
    const { module, index } = ctx;
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (!diffRelevant(ctx, m)) continue;
      if (!m.target?.symbolId) continue;
      const members = index.membersOf(m.target.symbolId);
      const memberNames = new Set(members.map((s) => s.name));
      for (const stub of m.stubbedMembers) {
        if (!memberNames.has(stub.name)) {
          out.push(
            issue(
              { module, index } as RuleContext,
              this.id,
              this.defaultSeverity,
              stub.span,
              `missing-member: '${stub.name}' does not exist on ${m.target.symbolId.split('#').pop()}`,
              renameFix(stub, [...memberNames]),
            ),
          );
        }
      }
    }
    return out;
  }
}

export class Drift002SignatureMismatch extends DriftRule {
  readonly id = 'DRIFT-002' as const;
  readonly name = 'signature-mismatch';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'stub call signature diverges from production (arity)';
  check(ctx: RuleContext): Issue[] {
    const { module, index } = ctx;
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (!diffRelevant(ctx, m)) continue;
      if (!m.target?.symbolId) continue;
      for (const stub of m.stubbedMembers) {
        if (!stub.signature) continue;
        const prod = index.membersOf(m.target.symbolId).find((s) => s.name === stub.name);
        if (!prod?.signature) continue;
        const req = (sig: NonNullable<typeof stub.signature>) =>
          sig.parameters.filter((p) => !p.optional && !p.variadic && !p.hasDefault).length;
        const stubReq = req(stub.signature);
        const prodReq = req(prod.signature);
        if (stubReq > prodReq) {
          out.push(
            issue(
              { module, index } as RuleContext,
              this.id,
              this.defaultSeverity,
              stub.span,
              `signature-mismatch: stub declares ${stubReq} required params, production has ${prodReq}`,
              { code: '', description: 'match the production parameter list' },
            ),
          );
          continue;
        }
        const mismatch = stub.signature.parameters.findIndex((param, i) => {
          const production = prod.signature!.parameters[i];
          return production !== undefined && !parameterAccepts(param, production);
        });
        if (mismatch >= 0) {
          const stubType =
            stub.signature.parameters[mismatch]?.type?.kind === 'named'
              ? stub.signature.parameters[mismatch]!.type!.name
              : 'unknown';
          const productionType =
            prod.signature.parameters[mismatch]?.type?.kind === 'named'
              ? prod.signature.parameters[mismatch]!.type!.name
              : 'unknown';
          out.push(
            issue(
              { module, index } as RuleContext,
              this.id,
              this.defaultSeverity,
              stub.span,
              `signature-mismatch: stub parameter ${mismatch + 1} (${stubType}) cannot accept production type (${productionType})`,
              { code: '', description: 'accept the production parameter types' },
            ),
          );
        }
      }
    }
    return out;
  }
}

function parameterAccepts(stub: ParamIR, production: ParamIR): boolean {
  // Missing annotations and unknown/any are conservative escape hatches.
  if (!stub.type || !production.type) return true;
  return typeAssignable(production.type, stub.type);
}

/** Approximate directional assignability for the syntax-level TypeIR contract. */
function typeAssignable(source: TypeIR, target: TypeIR): boolean {
  if (source.kind === 'unknown' || target.kind === 'unknown') return true;
  // source unions must check first: `string|number` → `string|number` needs every source
  // member accepted by the target (checked against target-union below), not each source
  // member against a single arbitrary target member.
  if (source.kind === 'union') return source.members.every((member) => typeAssignable(member, target));
  if (target.kind === 'union') return target.members.some((member) => typeAssignable(source, member));
  if (source.kind === 'literal') {
    if (target.kind === 'literal') return source.value === target.value;
    if (target.kind === 'named') {
      return (
        (typeof source.value === 'string' && target.name === 'string') ||
        (typeof source.value === 'number' && target.name === 'number') ||
        (typeof source.value === 'boolean' && target.name === 'boolean')
      );
    }
  }
  if (source.kind !== target.kind) return false;
  if (source.kind === 'named' && target.kind === 'named') {
    return (
      source.name === target.name &&
      source.typeArgs.length === target.typeArgs.length &&
      source.typeArgs.every((arg, i) => typeAssignable(arg, target.typeArgs[i]!))
    );
  }
  if (source.kind === 'array' && target.kind === 'array') {
    return !source.element || !target.element || typeAssignable(source.element, target.element);
  }
  if (source.kind === 'tuple' && target.kind === 'tuple') {
    return (
      source.elements.length === target.elements.length &&
      source.elements.every((element, i) => typeAssignable(element, target.elements[i]!))
    );
  }
  return source.kind === target.kind;
}

export class Drift003ReturnTypeMismatch extends DriftRule {
  readonly id = 'DRIFT-003' as const;
  readonly name = 'return-type-mismatch';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'configured value is not assignable to the production return type';
  check(ctx: RuleContext): Issue[] {
    const { module, index } = ctx;
    const out: Issue[] = [];
    if (module.language === 'php') {
      // PHP: the parser has no type checker; compare declared types structurally here.
      for (const m of module.mocks) {
        if (!diffRelevant(ctx, m)) continue;
        if (!m.target?.symbolId) continue;
        const members = index.membersOf(m.target.symbolId);
        for (const stub of m.stubbedMembers) {
          const prod = members.find((s) => s.name === stub.name);
          if (!prod?.signature?.returnType) continue;
          for (const v of stub.returnValues) {
            if (!v.value) continue;
            if (!phpReturnAssignable(v.value, prod.signature.returnType, index, module.path)) {
              out.push(
                issue(
                  ctx,
                  this.id,
                  this.defaultSeverity,
                  v.span,
                  `return-type-mismatch: configured value does not match '${stub.name}'s production return type`,
                ),
              );
            }
          }
        }
      }
      return out;
    }
    if (module.language === 'python') {
      // Python: the parser has no cross-file type checker (annotations are textual), so compare
      // configured values against annotated production return types here (the PHP precedent).
      for (const m of module.mocks) {
        if (!diffRelevant(ctx, m)) continue;
        if (!m.target?.symbolId) continue;
        const members = index.membersOf(m.target.symbolId);
        for (const stub of m.stubbedMembers) {
          const prod = members.find((s) => s.name === stub.name);
          if (!prod?.signature?.returnType) continue;
          for (const v of stub.returnValues) {
            if (!v.value) continue;
            if (!pyReturnAssignable(v.value, prod.signature.returnType)) {
              out.push(
                issue(
                  ctx,
                  this.id,
                  this.defaultSeverity,
                  v.span,
                  `return-type-mismatch: configured value does not match '${stub.name}'s production return type`,
                ),
              );
            }
          }
        }
      }
      return out;
    }
    for (const m of module.mocks) {
      if (!diffRelevant(ctx, m)) continue;
      for (const v of m.configuredValues) {
        if (v.assignable === false) {
          out.push(
            issue(
              ctx,
              this.id,
              this.defaultSeverity,
              v.span,
              `return-type-mismatch: configured value does not match the production return type`,
            ),
          );
        }
      }
    }
    return out;
  }
}

/** Directional check: configured value → production return type (spec docs/03 §3.4). */
function phpReturnAssignable(value: TypeIR, production: TypeIR, index: SymbolIndex, fromModule: string): boolean {
  if (production.kind === 'unknown' || value.kind === 'unknown') return true; // escape hatch
  if (production.kind === 'union')
    return production.members.some((m) => phpReturnAssignable(value, m, index, fromModule));
  if (value.kind === 'union') return value.members.every((m) => phpReturnAssignable(m, production, index, fromModule));
  const isVoid = production.kind === 'void' || (production.kind === 'named' && production.name === 'void');
  if (isVoid) return value.kind === 'null' || value.kind === 'void';
  if (value.kind === 'null') {
    return (
      production.kind === 'null' ||
      (production.kind === 'named' && (production.name === 'null' || production.name === 'mixed'))
    );
  }
  if (production.kind === 'null') return false;
  const isArray = production.kind === 'array' || (production.kind === 'named' && production.name === 'array');
  if (isArray) return value.kind === 'array';
  if (production.kind === 'named') {
    const name = production.name;
    if (name === 'mixed') return true;
    if (name === 'int' || name === 'float') {
      return value.kind === 'literal'
        ? typeof value.value === 'number'
        : value.kind === 'named' && (value.name === 'int' || value.name === 'float');
    }
    if (name === 'string') {
      return value.kind === 'literal'
        ? typeof value.value === 'string'
        : value.kind === 'named' && value.name === 'string';
    }
    if (name === 'bool' || name === 'boolean') {
      return value.kind === 'literal'
        ? typeof value.value === 'boolean'
        : value.kind === 'named' && (value.name === 'bool' || value.name === 'boolean');
    }
    // class-like production type: identical names pass; otherwise resolve both sides
    if (value.kind === 'literal' || value.kind === 'array') return false;
    if (value.kind === 'named') {
      if (value.name === name) return true;
      const prodSym = index.resolveByName(name, fromModule);
      const valueSym = index.resolveByName(value.name, fromModule);
      if (!prodSym || !valueSym) return true; // unresolvable side → conservative pass
      return prodSym.id === valueSym.id;
    }
    return false;
  }
  return value.kind === production.kind;
}

/** Directional check for Python: configured value -> annotated production return type. */
function pyReturnAssignable(value: TypeIR, production: TypeIR): boolean {
  if (production.kind === 'unknown' || value.kind === 'unknown') return true; // escape hatch
  if (production.kind === 'union') return production.members.some((m) => pyReturnAssignable(value, m));
  if (value.kind === 'union') return value.members.every((m) => pyReturnAssignable(m, production));
  const isVoid = production.kind === 'void';
  if (isVoid) return value.kind === 'null' || value.kind === 'void';
  if (value.kind === 'null') {
    return production.kind === 'null' || (production.kind === 'named' && production.name === 'None');
  }
  if (production.kind === 'null') return false;
  if (production.kind === 'named') {
    const name = production.name;
    if (name === 'Any' || name === 'object') return true;
    if (name === 'int' || name === 'float') {
      return value.kind === 'literal'
        ? typeof value.value === 'number'
        : value.kind === 'named' && (value.name === 'int' || value.name === 'float');
    }
    if (name === 'str') {
      return value.kind === 'literal'
        ? typeof value.value === 'string'
        : value.kind === 'named' && value.name === 'str';
    }
    if (name === 'bool') {
      return value.kind === 'literal'
        ? typeof value.value === 'boolean'
        : value.kind === 'named' && value.name === 'bool';
    }
    if (name === 'list' || name === 'dict' || name === 'tuple' || name === 'set' || name === 'frozenset') {
      return value.kind === 'named' && value.name === name;
    }
    // class-like production type: literals/arrays never; identical names pass; unresolvable → conservative pass.
    if (value.kind === 'literal' || value.kind === 'array') return false;
    if (value.kind === 'named') return value.name === name;
    return true;
  }
  return value.kind === production.kind;
}

/** PHP-only in Phase 1 (PHPUnit constructor semantics). TS constructor drift is a compile error. */
export class Drift004ConstructorDrift extends DriftRule {
  readonly id = 'DRIFT-004' as const;
  readonly name = 'constructor-drift';
  readonly defaultSeverity = 'error' as const;
  readonly description = 'double construction omits required constructor parameters (PHP)';
  override appliesTo(m: ModuleIR): boolean {
    return m.kind === 'test' && m.language === 'php';
  }
  check(ctx: RuleContext): Issue[] {
    const { module, index } = ctx;
    const out: Issue[] = [];
    for (const mock of module.mocks) {
      if (!diffRelevant(ctx, mock)) continue;
      if (module.language !== 'php' || !mock.constructorArgs || !mock.target?.symbolId) continue;
      const constructor = index.membersOf(mock.target.symbolId).find((member) => member.name === '__construct');
      if (!constructor?.signature) continue;
      const required = constructor.signature.parameters.filter(
        (param) => !param.optional && !param.variadic && !param.hasDefault,
      ).length;
      if (mock.constructorArgs.count < required) {
        out.push(
          issue(
            { module, index } as RuleContext,
            this.id,
            this.defaultSeverity,
            mock.constructorArgs.span,
            `constructor-drift: double supplies ${mock.constructorArgs.count} constructor args, production requires ${required}`,
            { code: '', description: 'supply all required constructor arguments' },
          ),
        );
      }
    }
    return out;
  }
}

export class Drift005MissingExport extends DriftRule {
  readonly id = 'DRIFT-005' as const;
  readonly name = 'missing-export';
  readonly defaultSeverity = 'error' as const;
  readonly description = 'vi.mock factory keys reference exports that do not exist';
  check(ctx: RuleContext): Issue[] {
    const { module, index } = ctx;
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (!diffRelevant(ctx, m)) continue;
      if (m.target?.kind !== 'module' || !m.target.modulePath) continue;
      const target = index.getModule(m.target.modulePath);
      if (!target) continue; // module not indexed (node_modules etc.)
      // Check the full named-export list — const/type/enum exports are not class/function
      // symbols, so the symbol-only `exportsOf` would falsely flag their factory keys.
      const names = new Set(target.exports);
      for (const stub of m.stubbedMembers) {
        if (stub.api === 'mockFactoryKey' && !names.has(stub.name)) {
          out.push(
            issue(
              { module, index } as RuleContext,
              this.id,
              this.defaultSeverity,
              stub.span,
              `missing-export: factory key '${stub.name}' is not exported by '${m.target.specifier}'`,
              { code: `remove or rename '${stub.name}'`, description: `remove or rename '${stub.name}'` },
            ),
          );
        }
      }
    }
    return out;
  }
}

export class Drift006StaleMock extends DriftRule {
  readonly id = 'DRIFT-006' as const;
  readonly name = 'stale-mock';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'mock target changed since the base ref but the mock file was not updated (git-diff mode)';
  check(ctx: RuleContext): Issue[] {
    const { module, index, diff } = ctx;
    if (!diff) return [];
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (mockFileChanged(ctx, m)) continue;
      let targetChanged = false;
      let targetName = '';
      let memberNames: string[] = [];
      if (m.target?.symbolId) {
        targetChanged = diff.changedSymbolIds.has(m.target.symbolId);
        targetName = m.target.symbolId.split('#').pop() ?? '';
        memberNames = index.membersOf(m.target.symbolId).map((s) => s.name);
      } else if (m.target?.kind === 'module' && m.target.modulePath) {
        // module-target mock: stale when its production module file changed
        targetChanged = diff.changedPaths.some((p) => resolve(p) === m.target!.modulePath);
        targetName = m.target.modulePath.split(/[\\/]/).pop() ?? m.target.specifier ?? '';
        memberNames = index.getModule(m.target.modulePath)?.exports ?? [];
      }
      if (!targetChanged) continue;
      const prefix = `stale-mock: ${targetName} since ${diff.baseRef}; ${module.path.split(/[\\/]/).pop()} untouched; review: `;
      // fit member names inside the 80-char budget without truncating mid-word
      let message = prefix;
      let first = true;
      for (const name of memberNames.slice(0, 4)) {
        const need = first ? name.length : name.length + 2;
        if (message.length + need > 80) break;
        message += first ? name : `, ${name}`;
        first = false;
      }
      out.push(issue(ctx, this.id, this.defaultSeverity, m.span, message));
    }
    return out;
  }
}

export const driftRules: Rule[] = [
  new Drift000UnresolvableTarget(),
  new Drift001MissingMember(),
  new Drift002SignatureMismatch(),
  new Drift003ReturnTypeMismatch(),
  new Drift004ConstructorDrift(),
  new Drift005MissingExport(),
  new Drift006StaleMock(),
];
