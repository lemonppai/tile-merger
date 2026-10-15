import inquirer from 'inquirer';

/**
 * inquirer v14 的 prompt() 泛型极其复杂，这里做一层薄封装，
 * 对外暴露干净的类型，内部集中处理类型断言。
 */

export interface Choice<T> {
  name: string;
  value: T;
}

export type ChoiceOrSeparator<T> = Choice<T> | InstanceType<typeof inquirer.Separator>;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function prompt(question: Record<string, unknown>): Promise<Record<string, any>> {
  return (await inquirer.prompt([question] as any)) as Record<string, any>;
}

/** 单选列表（对应 inquirer 的 select 类型） */
export async function askSelect<T>(options: {
  message: string;
  choices: ChoiceOrSeparator<T>[];
  pageSize?: number;
}): Promise<T> {
  const answers = await prompt({
    type: 'select',
    name: 'result',
    message: options.message,
    choices: options.choices,
    pageSize: options.pageSize ?? 15,
    loop: false,
  });
  return answers.result as T;
}

/** 文本输入 */
export async function askInput(options: {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string;
}): Promise<string> {
  const answers = await prompt({
    type: 'input',
    name: 'result',
    message: options.message,
    default: options.default,
    validate: options.validate,
  });
  return answers.result as string;
}

/** 是/否确认 */
export async function askConfirm(options: { message: string; default?: boolean }): Promise<boolean> {
  const answers = await prompt({
    type: 'confirm',
    name: 'result',
    message: options.message,
    default: options.default ?? true,
  });
  return Boolean(answers.result);
}

/** 分隔线 */
export const separator = (): InstanceType<typeof inquirer.Separator> => new inquirer.Separator();
