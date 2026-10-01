// @effect-diagnostics nodeBuiltinImport:off

import { RotatingFileSink } from "@akeru/shared/logging";

import { type PendingRecord } from "./EventLogTypes.ts";

export async function writeBatchedMessages(
  sink: Pick<RotatingFileSink, "write">,
  records: ReadonlyArray<PendingRecord>,
  maxBytes: number,
  onWritten: (records: ReadonlyArray<PendingRecord>) => void,
): Promise<void> {
  let pendingRecords: Array<PendingRecord> = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pendingRecords.length === 0) return;
    const writtenRecords = pendingRecords;
    await sink.write(writtenRecords.map((record) => record.line).join(""));
    onWritten(writtenRecords);
    pendingRecords = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxBytes) {
      await flush();
    }

    pendingRecords.push(record);
    pendingBytes += record.bytes;

    if (pendingBytes >= maxBytes) {
      await flush();
    }
  }

  await flush();
}
