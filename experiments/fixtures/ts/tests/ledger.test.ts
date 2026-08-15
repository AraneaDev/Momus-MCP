import { describe, expect, it, vi } from 'vitest';
import { Db } from '../src/services/db';
import { LedgerService } from '../src/services/ledger';

vi.mock('../src/services/db', () => ({ Db: vi.fn(() => ({ query: vi.fn() })) }));

describe('LedgerService', () => {
  it('computes totals from the db (healthy — must stay quiet)', async () => {
    const dbMock = vi.mocked(new Db());
    dbMock.query.mockResolvedValue([
      { id: 'inv-1', totalCents: 4200, status: 'open' },
    ]);
    const service = new LedgerService(dbMock as unknown as Db);
    const invoice = await service.totalFor('inv-1');
    // flows through LedgerService -> NOT a mock echo; must not fire TAUT-002
    expect(invoice.totalCents).toBe(4200);
  });

  it('echoes the stub value against itself (TAUT-002 planted)', () => {
    const mocked = { getTotal: vi.fn() };
    mocked.getTotal.mockReturnValue(42);
    // asserts the stub's own configured return -> TAUT-002
    expect(mocked.getTotal()).toBe(42);
  });

  it('spies on a member that does not exist (DRIFT-001 planted)', async () => {
    const service = new LedgerService({} as Db);
    const spy = vi.spyOn(service, 'totalForX');
    await expect(service.totalFor('inv-1')).resolves.toBeDefined();
    // spy is never configured and never reached via production -> TAUT-006
    expect(spy).toHaveBeenCalled();
  });

  it('spies on an existing member (healthy — must stay quiet)', () => {
    const service = new LedgerService({} as Db);
    vi.spyOn(service, 'totalFor');
  });
});
