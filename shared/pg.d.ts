declare module "pg" {
  export type QueryResult<T = unknown> = {
    rows: T[];
    rowCount: number | null;
  };

  export interface PoolClient {
    query: <T = unknown>(text: string, values?: unknown[]) => Promise<QueryResult<T>>;
    release: () => void;
  }

  export class Pool {
    constructor(config?: Record<string, unknown>);
    query: <T = unknown>(text: string, values?: unknown[]) => Promise<QueryResult<T>>;
    connect: () => Promise<PoolClient>;
  }

  export const types: {
    setTypeParser: (oid: number, parser: (value: string) => unknown) => void;
  };
}
