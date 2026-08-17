import { describe, expect, it } from 'vitest';
import { parseAnnotation } from '../src/types.ts';

describe('parseAnnotation', () => {
  it('maps builtins', () => {
    expect(parseAnnotation('int')).toEqual({ kind: 'named', name: 'int', typeArgs: [] });
    expect(parseAnnotation('None')).toEqual({ kind: 'null' });
    expect(parseAnnotation('Any')).toEqual({ kind: 'unknown' });
  });

  it('unions and optionals', () => {
    expect(parseAnnotation('int | None')).toEqual({
      kind: 'union',
      members: [
        { kind: 'named', name: 'int', typeArgs: [] },
        { kind: 'null' },
      ],
    });
    expect(parseAnnotation('Optional[int]')).toEqual({
      kind: 'union',
      members: [
        { kind: 'named', name: 'int', typeArgs: [] },
        { kind: 'null' },
      ],
    });
  });

  it('generics', () => {
    expect(parseAnnotation('list[int]')).toEqual({
      kind: 'named',
      name: 'list',
      typeArgs: [{ kind: 'named', name: 'int', typeArgs: [] }],
    });
    expect(parseAnnotation('dict[str, int]')).toEqual({
      kind: 'named',
      name: 'dict',
      typeArgs: [
        { kind: 'named', name: 'str', typeArgs: [] },
        { kind: 'named', name: 'int', typeArgs: [] },
      ],
    });
  });

  it('strips quotes from forward refs', () => {
    expect(parseAnnotation('"Item"')).toEqual({ kind: 'named', name: 'Item', typeArgs: [] });
    expect(parseAnnotation('"Item | None"')).toEqual({
      kind: 'union',
      members: [
        { kind: 'named', name: 'Item', typeArgs: [] },
        { kind: 'null' },
      ],
    });
  });

  it('unknown for empty/ambiguous', () => {
    expect(parseAnnotation('')).toBeUndefined();
    expect(parseAnnotation('...')).toEqual({ kind: 'unknown' });
  });
});
