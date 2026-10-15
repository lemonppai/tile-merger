import chalk from 'chalk';
import logSymbols from 'log-symbols';

export const logger = {
  info(message: string): void {
    console.log(message);
  },
  success(message: string): void {
    console.log(`${chalk.green(logSymbols.success)} ${message}`);
  },
  warn(message: string): void {
    console.log(`${chalk.yellow(logSymbols.warning)} ${message}`);
  },
  error(message: string): void {
    console.error(`${chalk.red(logSymbols.error)} ${message}`);
  },
  step(message: string): void {
    console.log(`${chalk.cyan('›')} ${message}`);
  },
  title(message: string): void {
    console.log(chalk.bold.cyan(message));
  },
  dim: (message: string): string => chalk.gray(message),
  accent: (message: string): string => chalk.hex('#00C2A8')(message),
};

/** 单行进度渲染（仅在 TTY 下重绘，避免污染日志） */
export function createProgressRenderer(): {
  update: (text: string) => void;
  done: () => void;
} {
  const enabled = Boolean(process.stderr.isTTY);
  let lastLength = 0;

  return {
    update(text: string): void {
      if (!enabled) return;
      const line = text.length > 110 ? `${text.slice(0, 107)}...` : text;
      process.stderr.write(`\r${' '.repeat(lastLength)}\r${line}`);
      lastLength = line.length;
    },
    done(): void {
      if (!enabled || lastLength === 0) return;
      process.stderr.write(`\r${' '.repeat(lastLength)}\r`);
      lastLength = 0;
    },
  };
}
