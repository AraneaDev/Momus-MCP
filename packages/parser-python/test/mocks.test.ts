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

  it('captures a bound Mock(return_value=42) literal for TAUT-002, skips inline + non-literals', () => {
    const src = `from unittest import mock

def test_echo():
    m = mock.Mock(return_value=42)
    with mock.patch("builtins.input", mock.Mock(return_value="N")):
        pass
    n = mock.Mock(return_value=[])
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    // The bound `m` captures its literal return_value; the inline patch arg and the list literal
    // (`[]` — no statically-known literal) do not.
    const m = mod.mocks.find((mk) => mk.span.startLine === 4)!;
    expect(m.configuredValues).toEqual([
      expect.objectContaining({ api: 'return_value', value: { kind: 'literal', value: 42 } }),
    ]);
    const inline = mod.mocks.find((mk) => mk.span.startLine === 5)!;
    expect(inline.configuredValues).toHaveLength(0);
    const list = mod.mocks.find((mk) => mk.span.startLine === 7)!;
    expect(list.configuredValues).toHaveLength(0);
  });

  it('detects patch.multiple as a class-target mock with one stub per patched member', () => {
    const src = `from unittest.mock import patch, DEFAULT
from .repo import Service

def test_many():
    with patch.multiple(Service, fetch=DEFAULT, save=42) as values:
        pass
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const mock = mod.mocks.find((m) => m.pattern === 'patch-multiple')!;
    expect(mock).toBeDefined();
    expect(mock.target).toMatchObject({ kind: 'class', exportName: 'Service' });
    // Each keyword is a patched class member — emitted as a stub so DRIFT-001 checks it against
    // the production class (methods *and* class attributes). The keyword values are the patched
    // attribute values, not return values, so no configured values are recorded (no DRIFT-003).
    expect(mock.stubbedMembers.map((s) => s.name)).toEqual(['fetch', 'save']);
    expect(mock.stubbedMembers.every((s) => s.returnValues.length === 0)).toBe(true);
    expect(mock.configuredValues).toHaveLength(0);
  });

  it('detects monkeypatch.setattr', () => {
    const src = `def test_env(monkeypatch):
    monkeypatch.setattr(os, "environ", {"A": "1"})
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const mock = mod.mocks.find((m) => m.pattern === 'monkeypatch')!;
    expect(mock.target).toMatchObject({ kind: 'instance-member', exportName: 'os', memberName: 'environ' });
  });

  it('detects patch.dict as a module-target mock', () => {
    const src = `from unittest import mock

def test_env():
    with mock.patch.dict(os.environ, {"A": "1"}):
        pass
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const mock = mod.mocks.find((m) => m.pattern === 'patch-dict')!;
    expect(mock).toBeDefined();
    expect(mock.target).toMatchObject({ kind: 'module', specifier: 'os.environ' });
  });

  it('binds a mock created via the `mock.` module form so hand-off reachability works', () => {
    const src = `from unittest import mock
from .service import run

def test_it():
    m = mock.MagicMock(return_value=None)
    run(m)
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const m = mod.mocks.find((x) => x.pattern === 'autospec')!;
    expect(m.invocationSites.length).toBeGreaterThan(0);
  });

  it('marks a mock handed off via return_value= on a patch as reached', () => {
    const src = `from unittest import mock
from .db import connection

def test_sql():
    cursor = mock.MagicMock()
    cursor.execute.side_effect = Exception("boom")
    with mock.patch.object(connection, "cursor", return_value=cursor):
        connection.cursor()
`;
    const mod = parser.parseModule('/x/test_x.py', src, { config: undefined, resolveImport: () => null });
    const cursor = mod.mocks.find((m) => m.pattern === 'autospec')!;
    expect(cursor.invocationSites.length).toBeGreaterThan(0);
  });
});
