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

/** Bump when the Recovery Assessment Engine's scoring/candidate-action
 * heuristics change in a way that would change output for the same input
 * features (Aug 30). */
export const ASSESSMENT_ENGINE_VERSION = "1.0.0";

/** Bump when the Sep 2 evaluation harness's methodology changes (cohort
 * construction, temporal fairness model, metric formulas, RNG-seeding
 * scheme) in a way that would change evaluation output for the same
 * seed/dataset/assessment-engine versions. Does NOT change when the
 * underlying simulated system (generator, assessment, AI, policy,
 * executor, outcome model) changes — those are already covered by
 * GENERATOR_VERSION / DATASET_VERSION / ASSESSMENT_ENGINE_VERSION. */
export const EVALUATION_VERSION = "r2s-eval-v1";

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
