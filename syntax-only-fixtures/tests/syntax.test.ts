import { expect, it, vi } from 'vitest';
import { Widget } from '../src/widget';

const wrong = {
  run: vi.fn((value: string, extra: boolean) => value),
} as unknown as Widget;

const healthy = {
  run: vi.fn((value: string) => value),
} as unknown as Widget;

it('flags the over-arity syntax-only double', () => {
  expect(wrong.run('value', true)).toBeDefined();
});

it('keeps the matching syntax-only double healthy', () => {
  expect(healthy.run('value')).toBeDefined();
});
