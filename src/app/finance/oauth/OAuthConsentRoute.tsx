import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useLocation, useNavigate } from 'react-router-dom';
import OAuthConsentPage from './OAuthConsentPage';
import { createOAuthConsentApi } from './consent-api';

export default function OAuthConsentRoute({ client, ownerId }: { client: SupabaseClient; ownerId: string }) {
  const location = useLocation(),
    navigate = useNavigate();
  // Remove the short-lived attempt from history before reading any account data.
  const [attempt] = useState(() => new URLSearchParams(location.search).get('attempt') ?? '');
  const api = useMemo(() => createOAuthConsentApi(client, ownerId), [client, ownerId]);
  useEffect(() => {
    if (location.search) navigate('/oauth/consent', { replace: true });
  }, [location.search, navigate]);
  return <OAuthConsentPage api={api} attempt={attempt} onComplete={url => window.location.assign(url)} />;
}
