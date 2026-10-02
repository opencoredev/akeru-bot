/** Cells read by chart scales and labels. Missing cells render as zero or an empty label. */
export type ChartValue = string | number | boolean | Date | null | undefined;

const rowIds = new WeakMap<object, number>();

let nextRowId = 0;

/** Keep mark identity tied to a row, including repeated occurrences of that row. */
export function chartRows<T extends object>(data: T[]) {
  const occurrences = new Map<number, number>();

  return data.map((row, index) => {
    let id = rowIds.get(row);

    if (id === undefined) {
      id = nextRowId++;
      rowIds.set(row, id);
    }

    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);

    return { row, index, key: `${id}-${occurrence}` };
  });
}
