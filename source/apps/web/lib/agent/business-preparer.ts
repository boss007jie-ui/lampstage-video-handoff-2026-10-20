import type { Prisma } from "@prisma/client";
import type { ActorContext, AgentStep, Approval, Reservation, ReservationRef } from "./contracts";

export type AgentTransaction = Prisma.TransactionClient;
export interface BusinessPreparation {
  tx: AgentTransaction;
  actor: Readonly<ActorContext>;
  step: Readonly<AgentStep>;
  approval: Readonly<Approval> | null;
  reservations: readonly Readonly<Reservation>[];
  reservationRefs: readonly ReservationRef[];
}
/** 服务端注册。只能在传入事务内创建/复用业务 job、账务和 slot；禁止网络/文件 IO 或另开事务。 */
export type BusinessPreparer = (input: BusinessPreparation) => Promise<{ jobId: string }>;
export type BusinessPreparers = Readonly<Record<string, BusinessPreparer>>;

/** 固定一对一单位映射，业务 adapter 不得再次预留 core 已授权的积分。 */
export const IMAGE_CREDIT_PLATFORM_UNITS = 1;
