import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createFinanceMcpApi, type FinanceMcpGrantDraft, type FinanceMcpReview } from './api';

const owner = 'owner-a',
  credential = '11111111-1111-4111-8111-111111111111',
  account = 'synthetic-cash',
  noticeId = '22222222-2222-4222-8222-222222222222';
const draft: FinanceMcpGrantDraft = {
  credential_id: credential,
  access: 'read',
  accounts: [{ account_id: account, start_at: '2026-10-30T12:00:00Z' }],
  mailbox_ids: ['a'.repeat(64)],
  expense_categories: ['other'],
  income_categories: ['other'],
};
const grant = () => ({ ...structuredClone(draft), enabled: true });
const review = (): FinanceMcpReview => ({
  notice_id: noticeId,
  status: 'review',
  review_reason: 'missing_bank_reference',
  account_id: account,
  kind: 'purchase',
  bank_status: 'posted',
  amount: '20.20',
  currency: 'DOP',
  date: '2026-10-30',
  occurred_at: '2026-10-30T12:00:00Z',
  time_zone: 'America/Santo_Domingo',
  description: 'Comercio ficticio',
  category: null,
  created_at: '2026-10-30T12:01:00Z',
});
function setup(data: unknown) {
  const setHeader = vi.fn(async () => ({ data, error: null as null | { code: string; message: string } }));
  const rpc = vi.fn(() => ({ setHeader }));
  const getUser = vi.fn(async () => ({ data: { user: { id: owner } }, error: null }));
  const getSession = vi.fn(async () => ({ data: { session: { access_token: 'synthetic-session-token', user: { id: owner } } }, error: null }));
  const client = { rpc, auth: { getUser, getSession } } as unknown as SupabaseClient;
  return { api: createFinanceMcpApi(client, owner), rpc, setHeader, getUser, getSession };
}

describe('financial MCP browser management boundary', () => {
  it('makes no request on construction and lists only verified owner-session metadata', async () => {
    const h = setup({ items: [grant()], next_cursor: null });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(await h.api.listGrants()).toEqual([grant()]);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('tr8_mcp_finance_manage', { p_action: 'list', p_input: {} });
    expect(h.setHeader).toHaveBeenCalledWith('Authorization', 'Bearer synthetic-session-token');
    expect(h.getUser).toHaveBeenCalledTimes(2);
  });
  it('requires the exact requested accounts, currencies namespace, category and read/write scope to be acknowledged', async () => {
    const h = setup(grant());
    expect(await h.api.setGrant(draft)).toEqual(grant());
    h.setHeader.mockResolvedValue({ data: { ...grant(), access: 'write' }, error: null });
    await expect(h.api.setGrant(draft)).rejects.toThrow('No pudimos comprobar');
    h.setHeader.mockResolvedValue({ data: { ...grant(), accounts: [{ account_id: 'foreign-account', start_at: draft.accounts[0]!.start_at }] }, error: null });
    await expect(h.api.setGrant(draft)).rejects.toThrow('No pudimos comprobar');
    h.setHeader.mockResolvedValue({ data: { ...grant(), mailbox_ids: ['b'.repeat(64)] }, error: null });
    await expect(h.api.setGrant(draft)).rejects.toThrow('No pudimos comprobar');
  });
  it('accepts read-only grants without mailbox or import categories and rejects empty-mailbox write grants', async () => {
    const readDraft: FinanceMcpGrantDraft = { ...draft, mailbox_ids: [], expense_categories: [], income_categories: [] };
    const h = setup({ ...readDraft, enabled: true });
    expect(await h.api.setGrant(readDraft)).toEqual({ ...readDraft, enabled: true });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('tr8_mcp_finance_manage', { p_action: 'set_grant', p_input: readDraft });
    h.rpc.mockClear();
    await expect(h.api.setGrant({ ...readDraft, access: 'write' })).rejects.toThrow('Revisa');
    expect(h.rpc).not.toHaveBeenCalled();
    h.setHeader.mockResolvedValue({ data: { items: [{ ...readDraft, access: 'write', enabled: true }], next_cursor: null }, error: null });
    await expect(h.api.listGrants()).rejects.toThrow('No pudimos comprobar');
  });
  it.each([
    { ...draft, mailbox_ids: ['real-address@example.com'] },
    { ...draft, accounts: [] },
    { ...draft, accounts: [draft.accounts[0]!, draft.accounts[0]!] },
    { ...draft, mailbox_ids: [draft.mailbox_ids[0]!, draft.mailbox_ids[0]!] },
    { ...draft, accounts: [{ account_id: account, start_at: 'tomorrow' }] },
    { ...draft, expense_categories: ['not-a-category'] },
  ])('rejects invalid or overbroad grant parameters before any RPC', async candidate => {
    const h = setup(grant());
    await expect(h.api.setGrant(candidate as FinanceMcpGrantDraft)).rejects.toThrow('Revisa');
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('rejects unexpected credential/source material in management responses', async () => {
    const h = setup({ items: [{ ...grant(), token: 'do-not-expose' }], next_cursor: null });
    await expect(h.api.listGrants()).rejects.toThrow('No pudimos comprobar');
    h.setHeader.mockResolvedValue({ data: { items: [{ ...review(), body: 'full email body' }], next_cursor: null, version: '1' }, error: null });
    await expect(h.api.listReviews()).rejects.toThrow('No pudimos comprobar');
  });
  it('validates pagination, stable notice identities and matching dismissal/revocation acknowledgments', async () => {
    const h = setup({ items: [review()], next_cursor: null, version: '1' });
    expect((await h.api.listReviews({ limit: 50 })).items).toEqual([review()]);
    await expect(h.api.listReviews({ limit: 101 })).rejects.toThrow('página válida');
    h.setHeader.mockResolvedValue({ data: { ...review(), status: 'dismissed' }, error: null });
    expect((await h.api.dismissReview(noticeId)).status).toBe('dismissed');
    h.setHeader.mockResolvedValue({ data: { ...review(), status: 'review' }, error: null });
    await expect(h.api.dismissReview(noticeId)).rejects.toThrow('No pudimos comprobar');
    h.setHeader.mockResolvedValue({ data: { credential_id: credential, enabled: false }, error: null });
    await h.api.revokeGrant(credential);
    h.setHeader.mockResolvedValue({ data: { credential_id: noticeId, enabled: false }, error: null });
    await expect(h.api.revokeGrant(credential)).rejects.toThrow('No pudimos comprobar');
  });
  it('discards replies after owner identity changes', async () => {
    const h = setup({ items: [], next_cursor: null });
    h.getUser.mockResolvedValueOnce({ data: { user: { id: owner } }, error: null }).mockResolvedValueOnce({ data: { user: { id: 'owner-b' } }, error: null });
    await expect(h.api.listGrants()).rejects.toThrow('Tu sesión cambió');
  });
  it('refuses a different current owner before any finance RPC and never reflects raw diagnostics', async () => {
    const h = setup(null);
    h.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'synthetic-session-token', user: { id: 'owner-b' } } }, error: null });
    await expect(h.api.listGrants()).rejects.toThrow('Tu sesión cambió');
    expect(h.rpc).not.toHaveBeenCalled();
    h.setHeader.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'secret or bank number' } });
    await expect(h.api.listGrants()).rejects.toThrow('No se pudo confirmar');
    h.setHeader.mockRejectedValueOnce(Error('secret or bank number'));
    try {
      await h.api.listGrants();
    } catch (cause) {
      expect(String(cause)).not.toContain('secret or bank number');
    }
  });
});
