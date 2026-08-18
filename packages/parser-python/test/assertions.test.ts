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

  it('marks a direct Mock(return_value=…) call as mock-config for TAUT-002 echo', () => {
    const src = `from unittest import mock

def test_echo():
    m = mock.Mock(return_value=42)
    assert m() == 42
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const a = mod.assertions[0]!;
    expect(a.operands[0]!.provenance).toBe('mock-config');
    expect(a.operands[0]!.configuredValue).toBe('42');
    expect(a.operands[0]!.mockRefs).toHaveLength(1);
  });

  it('marks a direct Mock(return_value=…) call as reached (no zero-reach stub)', () => {
    const src = `from unittest import mock

def test_direct():
    m = mock.Mock(return_value=42)
    result = m()
    assert result == 7
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.mocks[0]!.invocationSites.length).toBeGreaterThan(0);
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

  it('extracts assert_called assertions with the mock ref', () => {
    const src = `from unittest.mock import Mock

def test_it():
    m = Mock()
    m.assert_called()
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.assertions.some((a) => a.api === 'assert_called' && a.operands[0]?.mockRefs.length === 1)).toBe(true);
  });

  it('computes hasProductionCalls for a test that calls an imported production name', () => {
    const src = `from .service import normalize

def test_it():
    m = Mock()
    normalize(m)
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const fn = mod.functions[0]!;
    expect(fn.hasProductionCalls).toBe(true);
    expect(fn.productionCallCount).toBe(1);
  });

  it('leaves hasProductionCalls false for a mock-only test', () => {
    const src = `from unittest.mock import Mock

def test_it():
    m = Mock()
    m.get.return_value = 42
    m.get.assert_called_once()
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.functions[0]!.hasProductionCalls).toBe(false);
  });

  it('leaves hasProductionCalls false for framework-only calls (self.assertEqual)', () => {
    const src = `import unittest

class TestThing(unittest.TestCase):
    def test_x(self):
        self.assertEqual(1, 1)
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.functions[0]!.hasProductionCalls).toBe(false);
  });

  it('does not count a mock binding that shadows an imported production name', () => {
    const src = `from .service import run
from unittest.mock import Mock

def test_it():
    run = Mock()
    run.assert_called()
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.functions[0]!.hasProductionCalls).toBe(false);
  });
});
