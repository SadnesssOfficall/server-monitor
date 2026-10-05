export interface Issue {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  constructor(readonly issues: Issue[]) {
    super('validation failed');
    this.name = 'ValidationError';
  }
}

const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= LAST_CONTROL_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

export type Raw = Record<string, unknown>;

export function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Collector {
  readonly issues: Issue[] = [];

  add(field: string, message: string): void {
    this.issues.push({ field, message });
  }

  rejectUnknown(raw: Raw, allowed: readonly string[]): void {
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) this.add(key, 'unknown field');
    }
  }

  finish(): void {
    if (this.issues.length > 0) throw new ValidationError(this.issues);
  }

  integer(raw: Raw, key: string, range: { min: number; max: number }, fallback: number): number {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.add(key, 'must be an integer');
      return fallback;
    }
    if (value < range.min || value > range.max) {
      this.add(key, `must be between ${range.min} and ${range.max}`);
    }
    return value;
  }

  boolean(raw: Raw, key: string, fallback: boolean): boolean {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      this.add(key, 'must be a boolean');
      return fallback;
    }
    return value;
  }

  text(raw: Raw, key: string, max: number, required: boolean): string | null {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (required) this.add(key, 'is required');
      return null;
    }
    if (typeof value !== 'string') {
      this.add(key, 'must be a string');
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > max) {
      this.add(key, `must be between 1 and ${max} characters`);
      return null;
    }
    if (hasControlCharacter(trimmed)) {
      this.add(key, 'must not contain control characters');
      return null;
    }
    return trimmed;
  }

  choice<T extends string>(raw: Raw, key: string, options: readonly T[], fallback?: T): T | null {
    const value = raw[key];
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value === 'string') {
      const match = options.find((option) => option === value);
      if (match !== undefined) return match;
    }
    this.add(key, `must be one of: ${options.join(', ')}`);
    return null;
  }

  stringList(raw: Raw, key: string, max: number, check: (item: string) => boolean): string[] {
    const value = raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) {
      this.add(key, `must be an array of at most ${max} items`);
      return [];
    }
    const items: unknown[] = value;
    const valid = items.filter((item): item is string => typeof item === 'string' && check(item));
    if (valid.length !== items.length) this.add(key, 'contains an invalid item');
    return [...new Set(valid)];
  }
}
