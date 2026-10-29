import 'reflect-metadata';
import {
  createClock,
  fromMinorUnits,
  PaginationDto,
  toMinorUnits,
} from './primitives';

describe('money helpers', () => {
  it('converts decimal strings without floating-point rounding', () => {
    expect(toMinorUnits('12.30')).toBe(1230);
    expect(toMinorUnits('-0.05')).toBe(-5);
    expect(fromMinorUnits(1230)).toBe('12.30');
    expect(fromMinorUnits(123, 0)).toBe('123');
  });

  it('rejects excess precision', () => {
    expect(() => toMinorUnits('1.001')).toThrow('at most 2 decimal places');
  });
});

describe('PaginationDto', () => {
  it('provides bounded defaults', () => {
    const pagination = new PaginationDto();
    expect(pagination).toEqual({ limit: 20, offset: 0 });
  });
});

describe('clock', () => {
  it('uses the supplied time source', () => {
    const instant = new Date('2026-01-01T00:00:00.000Z');
    expect(createClock(() => instant).now()).toBe(instant);
  });
});
