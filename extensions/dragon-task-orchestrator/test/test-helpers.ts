import { DEFAULTS } from "../src/config-schema.js";
import type { DragonTaskOrchestratorConfig } from "../src/types.js";

/**
 * Build a test config, overriding only what a test cares about.
 *
 * `prdConfirmation` is merged field-by-field rather than replaced, so a test that
 * only cares about (say) `enabled: true` does not have to restate the timeout and
 * round-cap defaults alongside it.
 */
export function testConfig(
  overrides: Omit<Partial<DragonTaskOrchestratorConfig>, "prdConfirmation"> & {
    prdConfirmation?: Partial<DragonTaskOrchestratorConfig["prdConfirmation"]>;
  } = {},
): DragonTaskOrchestratorConfig {
  const { prdConfirmation, ...rest } = overrides;
  return {
    ...DEFAULTS,
    enabled: true,
    ...rest,
    prdConfirmation: { ...DEFAULTS.prdConfirmation, ...prdConfirmation },
  };
}
