#!/usr/bin/env bash
# Regenerate the agent-fleet-tick edge bundle from src/.
# The fleet modules are plain TS with ".js" ESM specifiers (Node/tsx);
# the Deno edge runtime wants ".ts". Everything else runs unchanged
# thanks to env-shim.ts. Run after ANY change to src/*.ts, then redeploy
# the agent-fleet-tick function.
set -euo pipefail
cd "$(dirname "$0")/.."

for f in agents.ts bus.ts agent.ts llm.ts tools.ts finance.ts seed.ts; do
  sed 's/\.js"/.ts"/g' "src/$f" > "edge/agent-fleet-tick/$f"
done
echo "edge/agent-fleet-tick refreshed from src/ — redeploy the function to apply."
