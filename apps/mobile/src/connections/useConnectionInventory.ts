import { useCallback, useEffect, useState } from 'react';
import { createConnectionInventory } from './connectionInventory';

export function useConnectionInventory(...readers: Parameters<typeof createConnectionInventory>) {
  const [reader] = useState(() => createConnectionInventory(...readers));
  const [inventory, setInventory] = useState(reader.snapshot);
  const load = useCallback(() => reader.refresh(setInventory), [reader]);
  useEffect(() => {
    void load();
    // Fences late reads on unmount/account change, and remains usable after
    // React StrictMode's cleanup/setup cycle on the same mounted account.
    return () => reader.invalidate();
  }, [load, reader]);
  return { inventory, load };
}
