import { useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { Check, Equal } from 'lucide-react';
import { evaluateAmountExpression, isAmountExpression } from './amount-expression';
import './amount-input.css';

type Edit = { value: string; start: number; end: number; direction: 'forward' | 'backward' | 'none' };
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> & {
  digits: number;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

export default function AmountInput({
  digits,
  value,
  defaultValue = '',
  onValueChange,
  onKeyDown,
  onSelect,
  onBeforeInput,
  onFocus,
  onBlur,
  disabled,
  readOnly,
  'aria-describedby': describedBy,
  ...props
}: Props) {
  const controlled = value !== undefined;
  const [local, setLocal] = useState(defaultValue);
  const [focused, setFocused] = useState(false);
  const text = value ?? local;
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const history = useRef<{ past: Edit[]; current: Edit; future: Edit[] }>({
    past: [],
    current: { value: text, start: text.length, end: text.length, direction: 'none' },
    future: [],
  });
  const selection = useRef<Edit | null>(null);
  function capture() {
    const node = input.current;
    if (node && node.value === history.current.current.value) {
      history.current.current = {
        value: node.value,
        start: node.selectionStart ?? node.value.length,
        end: node.selectionEnd ?? node.value.length,
        direction: node.selectionDirection ?? 'none',
      };
    }
  }
  useLayoutEffect(() => {
    if (history.current.current.value !== text) {
      history.current = { past: [], current: { value: text, start: text.length, end: text.length, direction: 'none' }, future: [] };
      selection.current = null;
    }
    const target = selection.current;
    if (target && input.current && target.value === text) {
      input.current.setSelectionRange(target.start, target.end, target.direction);
      selection.current = null;
    }
  }, [text]);
  function publish(edit: Edit) {
    selection.current = edit;
    if (!controlled) setLocal(edit.value);
    onValueChange?.(edit.value);
  }
  function change(edit: Edit) {
    if (edit.value === history.current.current.value) return;
    history.current.past.push(history.current.current);
    if (history.current.past.length > 100) history.current.past.shift();
    history.current.current = edit;
    history.current.future = [];
    publish(edit);
  }
  let result: ReturnType<typeof evaluateAmountExpression> = null;
  let error = '';
  const expression = isAmountExpression(text);
  if (expression) {
    try {
      result = evaluateAmountExpression(text, digits);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Revisa el cálculo.';
    }
  }
  const canApply = result !== null && !disabled && !readOnly;
  function apply() {
    if (!result || !canApply) return;
    capture();
    change({ value: result.decimal, start: result.decimal.length, end: result.decimal.length, direction: 'none' });
  }
  function insert(operator: string) {
    if (disabled || readOnly) return;
    capture();
    const current = history.current.current;
    const next = current.value.slice(0, current.start) + operator + current.value.slice(current.end);
    if (next.length > (props.maxLength ?? 256)) return;
    change({ value: next, start: current.start + operator.length, end: current.start + operator.length, direction: 'none' });
    input.current?.focus();
  }
  const showHint = expression && !disabled && !readOnly;
  return (
    <>
      <input
        {...props}
        ref={input}
        type="text"
        inputMode={props.inputMode ?? 'decimal'}
        maxLength={props.maxLength ?? 256}
        value={text}
        disabled={disabled}
        readOnly={readOnly}
        aria-describedby={[describedBy, showHint ? hintId : ''].filter(Boolean).join(' ') || undefined}
        onFocus={event => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={event => {
          setFocused(false);
          onBlur?.(event);
        }}
        onBeforeInput={event => {
          capture();
          onBeforeInput?.(event);
        }}
        onSelect={event => {
          capture();
          onSelect?.(event);
        }}
        onChange={event =>
          change({
            value: event.target.value,
            start: event.target.selectionStart ?? event.target.value.length,
            end: event.target.selectionEnd ?? event.target.value.length,
            direction: event.target.selectionDirection ?? 'none',
          })
        }
        onKeyDown={event => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.nativeEvent.isComposing || disabled || readOnly) return;
          capture();
          const key = event.key.toLowerCase();
          if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
            event.preventDefault();
            const redo = key === 'y' || event.shiftKey;
            const stack = redo ? history.current.future : history.current.past;
            const edit = stack.pop();
            if (edit) {
              (redo ? history.current.past : history.current.future).push(history.current.current);
              history.current.current = edit;
              publish(edit);
            }
          } else if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            apply();
          } else if (event.key === 'Enter' && canApply) {
            event.preventDefault();
            apply();
          }
        }}
      />
      {showHint && (
        <div className={`tf-amount-result${error ? ' has-error' : ''}`}>
          <output id={hintId} aria-live="polite">
            {result ? (
              <>
                <Equal size={14} aria-hidden="true" /> <strong>{result.decimal.replace('.', ',')}</strong>
                <span>Tab para aplicar{result.rounded ? ` · Redondeado a ${digits} decimales` : ''}</span>
              </>
            ) : (
              error
            )}
          </output>
          {canApply && (
            <button
              type="button"
              className="tf-amount-apply"
              tabIndex={-1}
              aria-label="Aplicar resultado"
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                apply();
                input.current?.focus();
              }}
            >
              <Check size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {focused && !disabled && !readOnly && (
        <div className="tf-amount-tools" role="group" aria-label="Operadores del importe">
          {[
            ['+', 'Insertar suma'],
            ['−', 'Insertar resta'],
            ['×', 'Insertar multiplicación'],
            ['÷', 'Insertar división'],
          ].map(([operator, label]) => (
            <button
              key={operator}
              type="button"
              tabIndex={-1}
              aria-label={label}
              onPointerDown={event => event.preventDefault()}
              onMouseDown={event => event.preventDefault()}
              onClick={() => insert(operator)}
            >
              {operator}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
