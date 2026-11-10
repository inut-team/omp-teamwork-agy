/**
 * Memoized proxy-reference index over the bundled model catalog.
 *
 * Lazy: walking every bundled model (~12K) triggers thinking enrichment, so the
 * walk is deferred off module load and performed once. Consumers that need
 * non-bundled reference data use the pure builder directly
 * ({@link buildModelReferenceIndex}).
 */
import { buildModel } from "../build";
import { isBareIdReferenceProvider } from "../compat/behavior";
import { providerEntry, seedModels } from "../compat/providers";
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model } from "../types";
import { buildModelReferenceIndex, type ModelReferenceIndex } from "./reference";

let bundledModels: readonly Model<Api>[] | undefined;

function getBundledModelList(): readonly Model<Api>[] {
	bundledModels ??= getBundledProviders()
		.filter(isBareIdReferenceProvider)
		.flatMap(provider => {
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			if (providerEntry(provider)?.seed?.bundle !== "always") return models;
			const seen = new Set(models.map(m => m.id));
			const seeded = seedModels(provider)
				.filter(spec => !seen.has(spec.id))
				.map(spec => buildModel({ ...spec, provider }));
			return seeded.length > 0 ? [...models, ...seeded] : models;
		});
	return bundledModels;
}

let referenceIndex: ModelReferenceIndex | undefined;

/** Proxy-reference index over the bundled catalog. */
export function getBundledModelReferenceIndex(): ModelReferenceIndex {
	referenceIndex ??= buildModelReferenceIndex(getBundledModelList());
	return referenceIndex;
}
