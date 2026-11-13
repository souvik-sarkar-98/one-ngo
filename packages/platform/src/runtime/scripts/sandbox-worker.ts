/**
 * One script worker thread (see `ScriptPool` in ./sandbox.ts). It loads QuickJS
 * once, then evaluates one script per message in a fresh runtime and context,
 * and answers with the harness's JSON text or the QuickJS error message.
 *
 * This file imports packages only, so it runs unbundled under tsx in
 * development and as its own esbuild entry (`dist/sandbox-worker.js`) in
 * production.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

export interface WorkerTask {
  id: number;
  payload: string;
  code: string;
  timeoutMs: number;
  memoryMb: number;
  /** Overrides the worker's usual output cap for this run. */
  maxOutputBytes?: number;
}

export type WorkerReply =
  | { id: number; raw: string; durationMs: number }
  | { id: number; error: string; durationMs: number }
  | { id: number; tooLarge: true; durationMs: number };

const { harness, maxOutputBytes } = workerData as { harness: string; maxOutputBytes: number };
const port = parentPort!;
const qjs = await getQuickJS();

port.on('message', (task: WorkerTask) => {
  const runtime = qjs.newRuntime();
  runtime.setMemoryLimit(task.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const started = performance.now();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + task.timeoutMs));
  const vm = runtime.newContext();
  let reply: WorkerReply;
  try {
    for (const [name, value] of [
      ['__input', task.payload],
      ['__code', task.code],
    ] as const) {
      const handle = vm.newString(value);
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    }
    const result = vm.evalCode(harness, 'script.js', { type: 'global' });
    const durationMs = Math.round(performance.now() - started);
    if (result.error) {
      const err = vm.dump(result.error) as { name?: string; message?: string } | string;
      result.error.dispose();
      reply = { id: task.id, error: typeof err === 'string' ? err : `${err?.name ?? 'Error'}: ${err?.message ?? ''}`, durationMs };
    } else {
      const raw = vm.dump(result.value);
      result.value.dispose();
      reply = typeof raw !== 'string' || raw.length > (task.maxOutputBytes ?? maxOutputBytes) ? { id: task.id, tooLarge: true, durationMs } : { id: task.id, raw, durationMs };
    }
  } catch (e) {
    reply = { id: task.id, error: String((e as Error)?.message ?? e), durationMs: Math.round(performance.now() - started) };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
  port.postMessage(reply);
});

port.postMessage({ ready: true });
