export class Db {
  async query<T>(sql: string, params?: unknown[]): Promise<T> {
    throw new Error('real db not available in tests');
  }
}
