export interface Invoice {
  id: string;
  totalCents: number;
  status: 'paid' | 'open';
}

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T>;
}

export class LedgerService {
  constructor(private db: Db) {}

  async totalFor(invoiceId: string): Promise<Invoice> {
    const rows = await this.db.query<Invoice[]>(
      'SELECT * FROM invoices WHERE id = ?',
      [invoiceId],
    );
    const row = rows[0];
    if (!row) throw new Error(`invoice not found: ${invoiceId}`);
    return row;
  }

  async markPaid(invoiceId: string): Promise<void> {
    await this.db.query('UPDATE invoices SET status = ? WHERE id = ?', [
      'paid',
      invoiceId,
    ]);
  }

  get balance(): Promise<number> {
    return this.db
      .query('SELECT SUM(total_cents) AS b FROM invoices')
      .then((r: { b: number }[]) => r[0].b);
  }
}
