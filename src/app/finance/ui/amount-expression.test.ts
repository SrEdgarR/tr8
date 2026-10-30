import { describe, expect, it } from 'vitest';
import { evaluateAmountExpression, isAmountExpression } from './amount-expression';

describe('amount expression calculator', () => {
  it.each([
    ['20.2 + 10', 2, '30.20', 3020, false],
    ['0.1 + 0.2', 2, '0.30', 30, false],
    ['20,2 + 10', 2, '30.20', 3020, false],
    ['20,2 + 10.3', 2, '30.50', 3050, false],
    ['2 + 3 * 4', 2, '14.00', 1400, false],
    ['(2 + 3) * 4', 2, '20.00', 2000, false],
    ['24 / 3 / 2', 2, '4.00', 400, false],
    ['9 - 3 - 2', 2, '4.00', 400, false],
    ['2 * -3', 2, '-6.00', -600, false],
    ['-(2 + 3)', 2, '-5.00', -500, false],
    ['+20', 2, '20.00', 2000, false],
    ['--20', 2, '20.00', 2000, false],
    ['20 − 3 × 2 ÷ 4', 2, '18.50', 1850, false],
    ['.5 + ,25', 2, '0.75', 75, false],
    ['1 / 3', 2, '0.33', 33, true],
    ['2 / 3', 2, '0.67', 67, true],
    ['-1 / 8', 2, '-0.13', -13, true],
    ['1 / 8', 2, '0.13', 13, true],
    ['1 / 3 * 3', 2, '1.00', 100, false],
    ['0.005 + 0', 2, '0.01', 1, true],
    ['-0.004 + 0', 2, '0.00', 0, true],
    ['20 - 20', 2, '0.00', 0, false],
    ['1 / 2', 0, '1', 1, true],
    ['-1 / 2', 0, '-1', -1, true],
    ['1 / 8', 6, '0.125000', 125000, false],
    ['90071992547409.91 + 0', 2, '90071992547409.91', Number.MAX_SAFE_INTEGER, false],
    ['1000000000000000000 - 999999999999999999', 2, '1.00', 100, false],
  ])('evaluates %s at %i digits exactly', (input, digits, decimal, minor, rounded) => {
    expect(evaluateAmountExpression(input, digits)).toEqual({ decimal, minor, rounded });
  });

  it.each(['20', '20.2', '20,2', '-20', '-20.2', '-20,2', '0', ' 20.20 '])('preserves numeric literal %s', input => {
    expect(evaluateAmountExpression(input, 2)).toBeNull();
    expect(isAmountExpression(input)).toBe(false);
  });

  it.each(['20.2 + 10', '20-10', '20 − 10', '(20)', '+20', '--20', '1 × 2', '1 ÷ 2', '20 +'])('recognizes calculation %s', input => {
    expect(isAmountExpression(input)).toBe(true);
  });
  it.each(['', '-', '-20.', '20,', '20.20'])('does not identify partial normal amount %s as a calculation', input => {
    expect(isAmountExpression(input)).toBe(false);
  });

  it.each([
    '20 +',
    '20 -',
    '20 *',
    '20 /',
    '()',
    '(20 + 2',
    '20 + 2)',
    '2(3)',
    '(2)3',
    '2 ** 3',
    '2 // 3',
    '2 + * 3',
    '1 / 0',
    '1 / (2 - 2)',
    'NaN + 1',
    'Infinity + 1',
    '1e3 + 1',
    'Math.max(1,2)',
    'alert(1)',
    '2 % 3',
    '1,000.00 + 1',
    '1.000,00 + 1',
    '1 000 + 1',
    '1..2 + 1',
    '1,2,3 + 1',
    '1. + 1',
    '90071992547409.91 + .01',
    '-90071992547409.91 - .01',
  ])('rejects malformed or unsafe expression %s', input => {
    expect(() => evaluateAmountExpression(input, 2)).toThrow();
  });

  it('bounds length and nesting, including unary signs, before unbounded work', () => {
    expect(() => evaluateAmountExpression('1'.repeat(257), 2)).toThrow('256');
    expect(() => evaluateAmountExpression('('.repeat(17) + '1' + ')'.repeat(17), 2)).toThrow('16');
    expect(() => evaluateAmountExpression('-'.repeat(17) + '1', 2)).toThrow('16');
    expect(evaluateAmountExpression('('.repeat(16) + '1' + ')'.repeat(16), 2)?.minor).toBe(100);
  });

  it.each([-1, 7, 1.5, Number.NaN])('rejects unsupported currency precision %s', digits => {
    expect(() => evaluateAmountExpression('1 + 2', digits)).toThrow('precisión');
  });
});
