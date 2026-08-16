export const RULES_CATALOG = [
  {
    id: 'TAUT-001',
    name: 'self-comparison',
    severity: 'error',
    description: 'assertion compares an expression with itself',
  },
  {
    id: 'TAUT-002',
    name: 'mock-echo',
    severity: 'error',
    description: "assertion re-asserts a stub's own configured return",
  },
  {
    id: 'TAUT-003',
    name: 'constant-tautology',
    severity: 'error',
    description: 'both assertion sides are compile-time constants',
  },
  {
    id: 'TAUT-004',
    name: 'mock-only-assertion',
    severity: 'warning',
    description: 'test exercises no production code',
  },
  {
    id: 'TAUT-005',
    name: 'zero-reach-stub',
    severity: 'warning',
    description: 'mock configured but never invoked or asserted',
  },
  {
    id: 'TAUT-006',
    name: 'unconfigured-spy-assert',
    severity: 'warning',
    description: 'toHaveBeenCalled* on a spy with no stub and no call path',
  },
  {
    id: 'DRIFT-001',
    name: 'missing-member',
    severity: 'error',
    description: 'stubbed member does not exist on the production target',
  },
  {
    id: 'DRIFT-002',
    name: 'signature-mismatch',
    severity: 'warning',
    description: 'stub call signature diverges from production (arity)',
  },
  {
    id: 'DRIFT-003',
    name: 'return-type-mismatch',
    severity: 'warning',
    description: 'configured value not assignable to the production return type',
  },
  {
    id: 'DRIFT-005',
    name: 'missing-export',
    severity: 'error',
    description: 'vi.mock factory keys reference exports that do not exist',
  },
  { id: 'MOCK-001', name: 'mock-saturation', severity: 'warning', description: 'over-mocking heuristic' },
  {
    id: 'MOCK-002',
    name: 'mock-of-self',
    severity: 'info',
    description: 'the test mocks a module it also imports as the SUT',
  },
] as const;
