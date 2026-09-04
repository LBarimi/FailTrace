import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

// Loaded with --import before Core: named node:fs/promises imports see these wrappers.
let metrics;
function reset() {
  metrics = { promiseCalls: {}, fileHandleCalls: {}, metadataBytesWritten: 0,
    parentBytesWritten: 0, unmeasuredWriteCalls: 0, fsyncCalls: 0, fsyncCompleted: 0 };
}
reset();
const count = (group, name) => { metrics[group][name] = (metrics[group][name] ?? 0) + 1; };
const metadata = (path) => /\.(?:json|jsonl)(?:\.|$)/.test(basename(String(path)));
function dataBytes(data, options) {
  if (typeof data === 'string') return Buffer.byteLength(data, typeof options === 'string' ? options : options?.encoding ?? 'utf8');
  return ArrayBuffer.isView(data) ? data.byteLength : null;
}
function written(path, bytes) {
  if (bytes === null) { metrics.unmeasuredWriteCalls++; return; }
  metrics.parentBytesWritten += bytes;
  if (metadata(path)) metrics.metadataBytesWritten += bytes;
}
function instrumentHandle(handle, path) {
  for (const name of ['writeFile', 'appendFile', 'write', 'writev', 'read', 'readFile', 'stat', 'sync', 'datasync', 'close', 'truncate']) {
    const original = handle[name].bind(handle);
    handle[name] = async (...args) => {
      count('fileHandleCalls', name);
      if (name === 'sync' || name === 'datasync') metrics.fsyncCalls++;
      const result = await original(...args);
      if (name === 'writeFile' || name === 'appendFile') written(path, dataBytes(args[0], args[1]));
      if (name === 'write' || name === 'writev') written(path, result.bytesWritten);
      if (name === 'sync' || name === 'datasync') metrics.fsyncCompleted++;
      return result;
    };
  }
  return handle;
}
for (const [name, original] of Object.entries(fs.promises)) {
  if (typeof original !== 'function') continue;
  fs.promises[name] = async (...args) => {
    count('promiseCalls', name);
    const result = await original(...args);
    if (name === 'open') return instrumentHandle(result, args[0]);
    if (name === 'writeFile' || name === 'appendFile') written(args[0], dataBytes(args[1], args[2]));
    return result;
  };
}
syncBuiltinESMExports();
globalThis.__failtraceBenchmark = { reset, snapshot: () => structuredClone(metrics) };
