import { createPinnedControlAuthority } from './control-client.ts';
import { createBlobWitness } from './blob-witness.ts';
import { witnessedAuthority } from './witness.ts';
export const PERSONAL_PINS = {
  personal: {
    ownerId: '74368b81-39f8-4bc3-bbbf-f541b64df4cf',
    authorityId: 'f441d794-a20e-43be-a286-b7d29efcfe7c',
    origin: 'https://tr8-vault.sredgarpadilla.workers.dev',
  },
  staging: {
    ownerId: '37848d70-989a-4f69-b124-0c959d8b49a6',
    authorityId: 'c6d34957-82b7-40d7-a378-7aa71a5841f2',
    origin: 'https://tr8-vault-staging.sredgarpadilla.workers.dev',
  },
} as const;
export function personalAuthority(get: (key: string) => string | undefined) {
  const mode = get('TR8_LIVE_MODE') === 'personal' ? 'personal' : 'staging';
  const pins = PERSONAL_PINS[mode],
    secret = get('TR8_LIVE_CONTROL_SECRET') ?? '',
    token = get('TR8_LIVE_BLOB_TOKEN') ?? '';
  const configured = get('TR8_LIVE_MODE') === mode && get('TR8_LIVE_AUTHORITY') === pins.authorityId && /^[a-f0-9]{64}$/.test(secret) && Boolean(token);
  const base = createPinnedControlAuthority({ ...pins, secret, configured, caseId: mode });
  return { pins, authority: witnessedAuthority(base, createBlobWitness(token, pins.authorityId, pins.ownerId), pins.authorityId, pins.ownerId) };
}
