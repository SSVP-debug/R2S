// =============================================================================
// Simulation metadata / versioning
// =============================================================================
// Every generated dataset is tagged with a seed, the generator's own version
// (bump this when generator LOGIC changes, even if the seed is unchanged),
// and a dataset schema version (bump when the SHAPE of generated records
// changes). This makes experiments reproducible even as R2S evolves later.
// =============================================================================

import type { SimulationRun } from "../domain/types.js";

/** Bump when generator.ts / groundTruth.ts / failureTaxonomy.ts logic
 * changes in a way that would change output for the same seed. */
export const GENERATOR_VERSION = "1.0.0";

/** Bump when the shape of generated records (fields, relations) changes. */
export const DATASET_VERSION = "r2s-dataset-v1";

export function buildSimulationRun(
  id: string,
  seed: string,
  createdAt: Date = new Date(),
): SimulationRun {
  return {
    id,
    seed,
    generatorVersion: GENERATOR_VERSION,
    datasetVersion: DATASET_VERSION,
    createdAt,
  };
}
