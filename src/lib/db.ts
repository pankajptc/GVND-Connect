export type Sql = {
  query: <T = unknown>(_sql: string, _params?: unknown[]) => Promise<T[]>;
};

const noopSql: Sql = {
  async query<T = unknown>() {
    return [] as T[];
  },
};

export async function getSql(): Promise<Sql> {
  return noopSql;
}

export const db = noopSql;
