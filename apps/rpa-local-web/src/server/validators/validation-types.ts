export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function errorIssue(code: string, path: string, message: string): ValidationIssue {
  return { severity: 'error', code, path, message };
}

export function warningIssue(code: string, path: string, message: string): ValidationIssue {
  return { severity: 'warning', code, path, message };
}
