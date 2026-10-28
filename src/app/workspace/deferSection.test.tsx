import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferSection } from './deferSection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.restoreAllMocks());

describe('deferred workspace sections', () => {
  it('waits until its section mounts to request the module and exposes a loading status', async () => {
    function Content() {
      return <h2>Contenido de prueba QA</h2>;
    }
    const request = deferred<{ default: typeof Content }>();
    const load = vi.fn(() => request.promise);
    const Deferred = deferSection(load, 'Finanzas QA');
    expect(load).not.toHaveBeenCalled();

    function Fixture({ open }: { open: boolean }) {
      return <main>{open && <Deferred />}</main>;
    }
    const view = render(<Fixture open={false} />);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Fixture open />);
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Abriendo Finanzas QA…');
    expect(screen.queryByRole('heading', { name: 'Contenido de prueba QA' })).not.toBeInTheDocument();

    await act(async () => request.resolve({ default: Content }));
    expect(screen.getByRole('heading', { name: 'Contenido de prueba QA' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the newest props and callback when a pending module resolves', async () => {
    function Content({ label, onSelect }: { label: string; onSelect: () => void }) {
      return <button onClick={onSelect}>{label}</button>;
    }
    const request = deferred<{ default: typeof Content }>();
    const load = vi.fn(() => request.promise);
    const Deferred = deferSection(load, 'Calendario QA');
    const previous = vi.fn();
    const current = vi.fn();
    const view = render(<Deferred label="Versión anterior QA" onSelect={previous} />);

    view.rerender(<Deferred label="Versión actual QA" onSelect={current} />);
    expect(load).toHaveBeenCalledOnce();
    await act(async () => request.resolve({ default: Content }));

    expect(screen.queryByRole('button', { name: 'Versión anterior QA' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Versión actual QA' }));
    expect(current).toHaveBeenCalledOnce();
    expect(previous).not.toHaveBeenCalled();
  });

  it('retries a rejected module without replacing a sibling or losing its draft', async () => {
    function Content() {
      return <h2>Conexiones recuperadas QA</h2>;
    }
    function Draft() {
      const [value, setValue] = useState('');
      return <input aria-label="Borrador externo QA" value={value} onChange={event => setValue(event.target.value)} />;
    }
    const first = deferred<{ default: typeof Content }>();
    const retry = deferred<{ default: typeof Content }>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const Deferred = deferSection(load, 'Conexiones QA');
    const expectedFailure = Error('Synthetic chunk fetch failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <main>
        <Draft />
        <Deferred />
      </main>,
    );
    const draft = screen.getByRole('textbox', { name: 'Borrador externo QA' });
    fireEvent.change(draft, { target: { value: 'Texto que debe conservarse QA' } });

    await act(async () => first.reject(expectedFailure));
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos abrir Conexiones QA.');
    expect(consoleError.mock.calls.some(args => args.includes(expectedFailure))).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Borrador externo QA' })).toBe(draft);
    expect(draft).toHaveValue('Texto que debe conservarse QA');

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Abriendo Conexiones QA…');
    await act(async () => retry.resolve({ default: Content }));

    expect(screen.getByRole('heading', { name: 'Conexiones recuperadas QA' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Borrador externo QA' })).toBe(draft);
    expect(draft).toHaveValue('Texto que debe conservarse QA');
  });

  it('keeps the loaded content state and DOM instance through ordinary prop updates', async () => {
    function Content({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(value => value + 1)}>{`${label}: ${count}`}</button>;
    }
    const load = vi.fn(async () => ({ default: Content }));
    const Deferred = deferSection(load, 'Contador QA');
    const view = render(<Deferred label="Anterior QA" />);
    const button = await screen.findByRole('button', { name: 'Anterior QA: 0' });
    fireEvent.click(button);
    expect(button).toHaveTextContent('Anterior QA: 1');

    view.rerender(<Deferred label="Actual QA" />);

    expect(screen.getByRole('button', { name: 'Actual QA: 1' })).toBe(button);
    expect(load).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
