import type { Network } from "@/config/networks";
import { everyRpcSimulationServer, getRpcServer, readLatestLedger } from "@/lib/stellar/rpc";
import type { ContractAuthNetwork, ContractAuthRpc } from "./contract-auth";

export const rpcContractAuthNetwork: ContractAuthNetwork = {
  async latestLedger(network: Network): Promise<number> {
    return (await readLatestLedger(getRpcServer(network))).sequence;
  },
  providers(network: Network): ContractAuthRpc[] {
    return everyRpcSimulationServer(network);
  },
};
