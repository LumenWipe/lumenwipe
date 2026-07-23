import { create } from "zustand";
import type { Network } from "@/config/networks";

interface NetworkState {
  network: Network;
  setNetwork: (n: Network) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  network: "mainnet",
  setNetwork: (network) => set({ network }),
}));
