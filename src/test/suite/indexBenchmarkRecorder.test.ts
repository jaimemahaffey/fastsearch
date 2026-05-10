import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIndexBenchmarkRecorder } from '../../core/indexBenchmarkRecorder';

suite('indexBenchmarkRecorder', () => {
  test('disabled recorder does nothing when no output path is configured', async () => {
    const recorder = createIndexBenchmarkRecorder(undefined);

    recorder.record({ event: 'fileReady', elapsedMs: 10 });
    await recorder.flush();

    assert.equal(recorder.enabled, false);
    assert.equal(createIndexBenchmarkRecorder('').enabled, false);
  });

  test('enabled recorder writes benchmark events as JSON and preserves shape/order', async () => {
    const rootPath = path.join(process.cwd(), '.benchmark-recorder-test-output', `${process.pid}-${Date.now()}-${os.platform()}`);
    const outputPath = path.join(rootPath, 'benchmark.json');
    const recorder = createIndexBenchmarkRecorder(outputPath);

    try {
      recorder.record({ event: 'fileReady', elapsedMs: 10 });
      recorder.record({ event: 'symbolBatch', elapsedMs: 25, count: 4 });
      recorder.record({ event: 'symbolComplete', elapsedMs: 50 });

      await recorder.flush();

      const content = await fs.readFile(outputPath, 'utf8');
      assert.deepEqual(JSON.parse(content), {
        events: [
          { event: 'fileReady', elapsedMs: 10 },
          { event: 'symbolBatch', elapsedMs: 25, count: 4 },
          { event: 'symbolComplete', elapsedMs: 50 }
        ]
      });
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('flush writes the events recorded when it was requested', async () => {
    const rootPath = path.join(process.cwd(), '.benchmark-recorder-test-output', `${process.pid}-${Date.now()}-${os.platform()}-snapshot`);
    const outputPath = path.join(rootPath, 'benchmark.json');
    const recorder = createIndexBenchmarkRecorder(outputPath);

    try {
      recorder.record({ event: 'fileReady', elapsedMs: 10 });
      const firstFlush = recorder.flush();
      recorder.record({ event: 'textReady', elapsedMs: 20 });

      await firstFlush;

      assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), {
        events: [
          { event: 'fileReady', elapsedMs: 10 }
        ]
      });

      await recorder.flush();

      assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), {
        events: [
          { event: 'fileReady', elapsedMs: 10 },
          { event: 'textReady', elapsedMs: 20 }
        ]
      });
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});
