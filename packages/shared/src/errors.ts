/**
 * Structured error shape shared across process boundaries (runtime ⇄ native ⇄ UI).
 * `code` is machine-readable and stable; `message` is for humans.
 */
export interface MorrowErrorShape {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class MorrowError extends Error implements MorrowErrorShape {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MorrowError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toShape(): MorrowErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function toErrorShape(error: unknown): MorrowErrorShape {
  if (error instanceof MorrowError) return error.toShape();
  if (error instanceof Error) return { code: "INTERNAL", message: error.message };
  return { code: "INTERNAL", message: String(error) };
}
