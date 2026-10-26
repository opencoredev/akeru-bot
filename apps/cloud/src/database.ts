export interface CloudStatement {
  bind(...values: (string | number | null)[]): CloudStatement;
  first<T = object>(): Promise<T | null>;
  all<T = object>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface CloudDatabase {
  prepare(sql: string): CloudStatement;
  batch(statements: CloudStatement[]): Promise<{ meta: { changes: number } }[]>;
}
