#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from './commands.js';
import { CliError, errorRecord } from './errors.js';

async function main(): Promise<void> {
  const program = createProgram();
  try {
    if (process.argv.length === 2) { program.outputHelp(); return; }
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError && ['commander.helpDisplayed', 'commander.version'].includes(error.code)) return;
    const failure = error instanceof CommanderError
      ? new CliError(error.message, error.code, 0, undefined, error.exitCode || 1) : error;
    const record = errorRecord(failure, [process.env.VIBELETTER_TOKEN ?? '']);
    if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify(record)}\n`);
    else process.stderr.write(`Fehler [${record.error.code}]: ${record.error.message}\n`);
    process.exitCode = failure instanceof CliError ? failure.exitCode : 1;
  }
}

await main();
