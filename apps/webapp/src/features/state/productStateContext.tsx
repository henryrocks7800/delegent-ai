import { createContext, useContext, type ReactNode } from 'react';
import { useProductState, type ProductState } from './useProductState';
import type { WebAuthUser } from '../auth/useAuth';

// One product-state subscription for the whole app. Without this, every screen
// that needs the snapshot would start its own poll, and the provisioning poll
// would multiply by the number of mounted screens.

const ProductStateContext = createContext<ProductState | null>(null);

export function ProductStateProvider({ children, user }: { children: ReactNode; user: WebAuthUser }) {
  // Only ever mounted inside the signed-in tree, so the hook's signed-in guard
  // is always satisfied here. The user is passed through because a brand new
  // account has no product-state row yet, and the fail-closed snapshot that
  // stands in for it needs a profile to resolve the onboarding gate.
  const state = useProductState(true, user);
  return <ProductStateContext.Provider value={state}>{children}</ProductStateContext.Provider>;
}

export function useProductStateContext(): ProductState {
  const value = useContext(ProductStateContext);
  if (!value) throw new Error('useProductStateContext must be used inside ProductStateProvider');
  return value;
}
