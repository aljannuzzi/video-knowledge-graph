import { createGraphRuntimeGrantSql } from "@vkg/shared/server";

export function runtimeGrantStatement(userName: string, clientId: string): string {
  return createGraphRuntimeGrantSql({ principalName: userName, principalClientId: clientId });
}
