import { createInterface } from 'node:readline/promises';
import { main, type Io } from './main.js';

/** The real process: its working directory, output streams, and a terminal prompt when one is attached. */
export function processIo(): Io {
  return {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    ...(process.stdin.isTTY
      ? {
          prompt: async (question: string) => {
            const terminal = createInterface({ input: process.stdin, output: process.stderr });
            try {
              return await terminal.question(question);
            } finally {
              terminal.close();
            }
          },
        }
      : {}),
  };
}

/** Runs the CLI as a process and sets its exit code. */
export async function run(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2), processIo());
}
