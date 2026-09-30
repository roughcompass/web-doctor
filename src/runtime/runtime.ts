import type { EffectivePolicySnapshot } from "../contracts/index.js";
import { createEffectivePolicySnapshot, type EffectivePolicyOptions } from "./effective-policy.js";
import { loadEmbeddedRegistry, type EmbeddedRegistryOptions, type LoadedEmbeddedRegistry } from "./embedded-registry.js";
import { composePolicy, type PolicyCompositionOptions } from "./policy-composition.js";
import { resolvePackageUpdateState, type PackageUpdateOptions, type PackageUpdateState } from "./update-state.js";

export class WebDoctorRuntime {
  readonly registry: LoadedEmbeddedRegistry;

  private constructor(registry: LoadedEmbeddedRegistry) {
    this.registry = deepFreeze(registry);
  }

  static async create(options: EmbeddedRegistryOptions = {}): Promise<WebDoctorRuntime> {
    return new WebDoctorRuntime(await loadEmbeddedRegistry(options));
  }

  get registryDigest(): string {
    return this.registry.digest;
  }

  resolvePolicy(
    options: Omit<PolicyCompositionOptions, "registry">,
    snapshotOptions: Omit<EffectivePolicyOptions, "composition"> = {},
  ): EffectivePolicySnapshot {
    const composition = composePolicy({ ...options, registry: this.registry.snapshot });
    return createEffectivePolicySnapshot({ ...snapshotOptions, composition });
  }

  resolveUpdateState(options: PackageUpdateOptions): Promise<PackageUpdateState> {
    return resolvePackageUpdateState(options);
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}