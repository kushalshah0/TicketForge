import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function createClock(now: () => Date = () => new Date()): Clock {
  return { now };
}

export function toMinorUnits(amount: string, fractionDigits = 2): number {
  validateFractionDigits(fractionDigits);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);

  if (!match) throw new Error('Amount must be a decimal number');

  const [, sign, wholePart, fractionPart = ''] = match;
  if (fractionPart.length > fractionDigits) {
    throw new Error(`Amount supports at most ${fractionDigits} decimal places`);
  }

  const multiplier = 10 ** fractionDigits;
  const fraction = Number(fractionPart.padEnd(fractionDigits, '0') || '0');
  const value = Number(wholePart) * multiplier + fraction;

  if (!Number.isSafeInteger(value))
    throw new Error('Amount exceeds the safe integer range');
  return sign === '-' ? -value : value;
}

export function fromMinorUnits(
  amountMinor: number,
  fractionDigits = 2,
): string {
  validateFractionDigits(fractionDigits);
  if (!Number.isSafeInteger(amountMinor))
    throw new Error('Amount must be a safe integer');

  const sign = amountMinor < 0 ? '-' : '';
  const absoluteAmount = Math.abs(amountMinor);
  const multiplier = 10 ** fractionDigits;
  const whole = Math.floor(absoluteAmount / multiplier);
  if (fractionDigits === 0) return `${sign}${whole}`;

  const fraction = String(absoluteAmount % multiplier).padStart(
    fractionDigits,
    '0',
  );
  return `${sign}${whole}.${fraction}`;
}

function validateFractionDigits(fractionDigits: number): void {
  if (
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 6
  ) {
    throw new Error('Fraction digits must be an integer between 0 and 6');
  }
}
