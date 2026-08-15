/** Mock contract & drift rules (spec docs/03 §3.3.2). */
import type { Issue, ModuleIR, MockIR, RuleId, Severity, StubbedMemberIR } from '../ir.ts';
import type { Rule, RuleContext } from './engine.ts';

abstract class DriftRule implements Rule {
  abstract readonly id: RuleId;
  abstract readonly name: string;
  abstract readonly defaultSeverity: Severity;
  abstract readonly description: string;
  appliesTo(m: ModuleIR): boolean { return m.kind === 'test'; }
  abstract check(ctx: RuleContext): Issue[];
}

const issue = (
  ctx: RuleContext,
  rule: RuleId,
  severity: Severity,
  span: { file: string; startLine: number; startCol: number; endLine: number; endCol: number },
  message: string,
  fix?: { code: string; description: string },
): Issue => ({
  id: `${rule}:${span.file}:${span.startLine}:${span.startCol}:${message.slice(0, 24)}`,
  rule, severity, span,
  message: message.slice(0, 80),
  fix: fix ? { kind: 'replace', code: fix.code, description: fix.description.slice(0, 60) } : undefined,
  tokens: 0,
});

export class Drift000UnresolvableTarget extends DriftRule {
  readonly id = 'DRIFT-000' as const;
  readonly name = 'unresolvable-mock-target';
  readonly defaultSeverity = 'info' as const;
  readonly description = 'mock target could not be resolved to a production symbol';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (!m.target || m.target.kind === 'unknown') {
        out.push(issue({ module } as RuleContext, this.id, this.defaultSeverity, m.span,
          `unresolvable-mock-target: cannot resolve '${m.target?.specifier ?? 'dynamic'}'; checks skipped`));
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
  check({ module, index }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (!m.target?.symbolId) continue;
      const members = index.membersOf(m.target.symbolId);
      const memberNames = new Set(members.map((s) => s.name));
      for (const stub of m.stubbedMembers) {
        if (!memberNames.has(stub.name)) {
          out.push(issue({ module, index } as RuleContext, this.id, this.defaultSeverity, stub.span,
            `missing-member: '${stub.name}' does not exist on ${m.target.symbolId.split('#').pop()}`,
            { code: `rename stub to an existing member`, description: `rename stub to an existing member` }));
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
  check({ module, index }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (!m.target?.symbolId) continue;
      for (const stub of m.stubbedMembers) {
        if (!stub.signature) continue;
        const prod = index.membersOf(m.target.symbolId).find((s) => s.name === stub.name);
        if (!prod?.signature) continue;
        const req = (sig: NonNullable<typeof stub.signature>) =>
          sig.parameters.filter((p) => !p.optional && !p.variadic).length;
        const stubReq = req(stub.signature);
        const prodReq = req(prod.signature);
        if (stubReq > prodReq) {
          out.push(issue({ module, index } as RuleContext, this.id, this.defaultSeverity, stub.span,
            `signature-mismatch: stub declares ${stubReq} required params, production has ${prodReq}`,
            { code: '', description: 'match the production parameter list' }));
        }
      }
    }
    return out;
  }
}

export class Drift003ReturnTypeMismatch extends DriftRule {
  readonly id = 'DRIFT-003' as const;
  readonly name = 'return-type-mismatch';
  readonly defaultSeverity = 'warning' as const;
  readonly description = 'configured value is not assignable to the production return type';
  check({ module }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const m of module.mocks) {
      for (const v of m.configuredValues) {
        if (v.assignable === false) {
          out.push(issue({ module } as RuleContext, this.id, this.defaultSeverity, v.span,
            `return-type-mismatch: configured value does not match the production return type`));
        }
      }
    }
    return out;
  }
}

/** PHP-only in Phase 1 (PHPUnit constructor semantics). TS constructor drift is a compile error. */
export class Drift004ConstructorDrift extends DriftRule {
  readonly id = 'DRIFT-004' as const;
  readonly name = 'constructor-drift';
  readonly defaultSeverity = 'error' as const;
  readonly description = 'double construction omits required constructor parameters (PHP)';
  override appliesTo(m: ModuleIR): boolean { return m.kind === 'test' && m.language === 'php'; }
  check(): Issue[] { return []; } // Phase 2 (PHP parser enriches constructor marks)
}

export class Drift005MissingExport extends DriftRule {
  readonly id = 'DRIFT-005' as const;
  readonly name = 'missing-export';
  readonly defaultSeverity = 'error' as const;
  readonly description = 'vi.mock factory keys reference exports that do not exist';
  check({ module, index }: RuleContext): Issue[] {
    const out: Issue[] = [];
    for (const m of module.mocks) {
      if (m.target?.kind !== 'module' || !m.target.modulePath) continue;
      const exports = index.exportsOf(m.target.modulePath);
      if (exports.length === 0) continue; // module not indexed (node_modules etc.)
      const names = new Set(exports.map((s) => s.name));
      for (const stub of m.stubbedMembers) {
        if (stub.api === 'mockFactoryKey' && !names.has(stub.name)) {
          out.push(issue({ module, index } as RuleContext, this.id, this.defaultSeverity, stub.span,
            `missing-export: factory key '${stub.name}' is not exported by '${m.target.specifier}'`,
            { code: `remove or rename '${stub.name}'`, description: `remove or rename '${stub.name}'` }));
        }
      }
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
];
