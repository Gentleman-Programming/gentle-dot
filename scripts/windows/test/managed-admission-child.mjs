import { join } from 'node:path';

const challenge = Buffer.from('admission-v1');
const ack = Buffer.from('admission-ack-v1');

export async function exchange(channel) {
  await new Promise((resolve, reject) => {
    let offset = 0;
    const fail = () => settle(new Error('challenge-failed'));
    const receive = (part) => {
      const end = offset + part.length;
      if (end > challenge.length || !part.equals(challenge.subarray(offset, end))) return fail();
      offset = end;
      if (offset === challenge.length) settle();
    };
    const settle = (error) => {
      channel.off('data', receive);
      channel.off('end', fail);
      channel.off('error', fail);
      if (error) reject(error);
      else resolve();
    };
    channel.once('error', fail);
    channel.once('end', fail);
    channel.on('data', receive);
  });
  await new Promise((resolve, reject) => {
    channel.write(ack, (error) => error ? reject(new Error('ack-failed')) : resolve());
  });
}

async function run() {
  const recordDirectory = process.env.GENTLE_DOT_DATA_DIR;
  if (process.platform !== 'win32' || process.arch !== 'x64' ||
      process.version !== 'v24.14.1' || !recordDirectory) process.exit(60);

  let phase = 61;
  try {
    const { finishWindowsShutdown, startWithWindowsAppChannel } =
      await import('../../../packages/daemon/src/windows-stop.ts');
    phase = 63; // Between import and callback: stop-listener or exclusive FD3 admission.
    const managed = await startWithWindowsAppChannel(join(recordDirectory, 'daemon.pid'), async (channel) => {
      phase = 64;
      // The exchange handles errors while reading/writing; later errors must not dump a stack.
      channel.on('error', () => process.exit(64));
      await exchange(channel);
      let stopped;
      const closed = new Promise((resolve) => { stopped = resolve; });
      return { closed, async close() { stopped(); } };
    });
    await finishWindowsShutdown(managed); // Clean exit requires the production combined drain.
  } catch (error) {
    if (phase === 63 && error instanceof Error &&
        error.message.startsWith('Windows stop listener initialization failed:')) phase = 62;
    process.exit(phase);
  }
}

if (import.meta.main) await run();
