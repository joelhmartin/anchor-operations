import { useEffect, useState } from 'react';
import { fetchBrand } from 'api/brand';
import useAuth from 'hooks/useAuth';

// Returns the active client's display logo (PNG/JPG email-safe single logo) when
// the current portal context belongs to a client — either the user is a client,
// or a staff user is impersonating one via actingClientId. Returns null when
// there's no client context or when the client has not uploaded a display logo.
export default function useClientDisplayLogo() {
  const { user, actingClientId } = useAuth();
  const [logo, setLogo] = useState(null);

  const role = user?.role;
  const isClient = role === 'client';
  const shouldFetch = Boolean(user) && (isClient || Boolean(actingClientId));

  useEffect(() => {
    if (!shouldFetch) {
      setLogo(null);
      return undefined;
    }
    let cancelled = false;
    fetchBrand()
      .then((brand) => {
        if (cancelled) return;
        setLogo(brand?.display_logo?.url ? brand.display_logo : null);
      })
      .catch(() => {
        if (!cancelled) setLogo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldFetch, actingClientId, user?.id]);

  return logo;
}
