import { describe, expect, it, vi } from 'vitest';
import { InvoiceService } from '../src/services/invoice';

describe('InvoiceService', () => {
  it('planted: configures a return value not assignable to the production type (DRIFT-003)', () => {
    const svc = new InvoiceService();
    const spy = vi.spyOn(svc, 'totalCents');
    // planted: 'nope' is not assignable to the number return type (intentionally a type error)
    spy.mockReturnValue('nope');
    expect(svc.totalCents()).toBeDefined();
  });

  it('healthy: configures a return value assignable to the production type', () => {
    const svc = new InvoiceService();
    const spy = vi.spyOn(svc, 'totalCents');
    spy.mockReturnValue(42);
    expect(svc.totalCents()).toBeDefined();
  });
});
