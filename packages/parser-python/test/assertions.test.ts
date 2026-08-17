import { describe, expect, it } from 'vitest';
import { PythonParser } from '../src/index.ts';

const parser = new PythonParser();

describe('PythonParser assertions', () => {
  it('extracts a self-comparison from assert', () => {
    const src = `def test_x():
    x = 1
    assert x == x
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions[0]!;
    expect(a.api).toBe('==');
    expect(a.operands).toHaveLength(2);
    expect(a.operands[0]!.text).toBe('x');
    expect(a.operands[1]!.text).toBe('x');
  });

  it('marks a mock return_value operand as mock-config provenance', () => {
    const src = `from unittest.mock import Mock

def test_price():
    m = Mock(spec=Price)
    m.get_price.return_value = 42
    assert m.get_price() == 42
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions[0]!;
    expect(a.operands[0]!.provenance).toBe('mock-config');
    expect(a.operands[0]!.configuredValue).toBe('42');
  });

  it('marks reachable mocks (handed to a SUT call)', () => {
    const src = `from unittest.mock import Mock
from .service import run

def test_run():
    m = Mock(spec=Deps)
    run(m)
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.mocks[0]!.invocationSites.length).toBeGreaterThan(0);
  });

  it('extracts unittest assertEqual operands', () => {
    const src = `import unittest

class TestThing(unittest.TestCase):
    def test_x(self):
        self.assertEqual(1, 1)
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions[0]!;
    expect(a.api).toBe('assertEqual');
    expect(a.operands).toHaveLength(2);
  });
});
