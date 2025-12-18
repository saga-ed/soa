import chalk from 'chalk';

export class Logger {
  static command(message: string): void {
    console.log(chalk.blue(`🔨 ${message}`));
  }

  static info(message: string): void {
    console.log(chalk.gray(`ℹ️  ${message}`));
  }

  static success(message: string): void {
    console.log(chalk.green(`✅ ${message}`));
  }

  static error(message: string): void {
    console.log(chalk.red(`❌ ${message}`));
  }

  static cleanup(message: string): void {
    console.log(chalk.yellow(`🧹 ${message}`));
  }
}