declare module "eslint" {
  interface LintMessage {
    ruleId: string | null;
    message: string;
  }
  interface LintResult {
    messages: LintMessage[];
  }
  export class ESLint {
    constructor(options: { cwd: string });
    lintText(code: string, options: { filePath: string }): Promise<LintResult[]>;
  }
}
