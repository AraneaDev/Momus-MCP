import { describe, expect, it } from 'vitest';
import { PythonParser } from '../src/index.ts';

const parser = new PythonParser();

describe('PythonParser mocks', () => {
  it('detects patch.object as an instance-member target', () => {
    const src = `from unittest.mock import patch
from .repo import Repo

def test_save():
    with patch.object(Repo, "save", return_value=1) as m:
        pass
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const mock = mod.mocks.find((m) => m.pattern === 'patch-object')!;
    expect(mock.target).toMatchObject({ kind: 'instance-member', exportName: 'Repo', memberName: 'save' });
  });

  it('detects patch(module.attr) as a module target', () => {
    const src = `from unittest.mock import patch

def test_send():
    with patch("app.mail.send") as m:
        pass
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    expect(mod.mocks.some((m) => m.pattern === 'patch' && m.target?.specifier === 'app.mail.send')).toBe(true);
  });

  it('captures return_value as a configured value on a member stub', () => {
    const src = `from unittest.mock import Mock

def test_price():
    m = Mock(spec=Price)
    m.get_price.return_value = 42
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const stub = mod.mocks.flatMap((m) => m.stubbedMembers).find((s) => s.name === 'get_price')!;
    expect(stub).toBeDefined();
    expect(stub.returnValues).toHaveLength(1);
    expect(stub.returnValues[0]!.api).toBe('return_value');
    expect(stub.returnValues[0]!.value).toEqual({ kind: 'literal', value: 42 });
  });

  it('detects create_autospec and Mock(spec=) as autospec targets', () => {
    const src = `from unittest.mock import Mock, create_autospec

def test_a():
    a = create_autospec(Repo)
    b = Mock(spec=Repo)
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const specs = mod.mocks.filter((m) => m.pattern === 'autospec');
    expect(specs).toHaveLength(2);
    expect(specs.every((m) => m.target?.kind === 'class' && m.target.exportName === 'Repo')).toBe(true);
  });

  it('detects monkeypatch.setattr', () => {
    const src = `def test_env(monkeypatch):
    monkeypatch.setattr(os, "environ", {"A": "1"})
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const mock = mod.mocks.find((m) => m.pattern === 'monkeypatch')!;
    expect(mock.target).toMatchObject({ kind: 'instance-member', exportName: 'os', memberName: 'environ' });
  });
});
