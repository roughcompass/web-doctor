import npa from "npm-package-arg";
import ssri from "ssri";
import * as z from "zod/v4";

export const nonEmptyStringSchema = z.string().trim().min(1);
export const identifierSchema = nonEmptyStringSchema.regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const versionSchema = nonEmptyStringSchema;
export const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

export const schemaVersionEnvelopeSchema = z.object({
  schema: nonEmptyStringSchema,
  schemaVersion: z.int().positive(),
});

export function versionedDocumentFields<const Name extends string, const Version extends number>(
  schema: Name,
  schemaVersion: Version,
) {
  return {
    schema: z.literal(schema),
    schemaVersion: z.literal(schemaVersion),
  } as const;
}

export const sourceProvenanceSchema = z.strictObject({
  repository: nonEmptyStringSchema,
  commit: gitCommitSchema,
});

export const packagePathSchema = nonEmptyStringSchema.superRefine((value, context) => {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    context.addIssue({ code: "custom", message: "Package paths must be normalized relative POSIX paths" });
  }
});

export const npmIntegritySchema = nonEmptyStringSchema.superRefine((value, context) => {
  const parsed = ssri.parse(value, { strict: true });
  if (parsed === null || !Object.hasOwn(parsed, "sha512")) {
    context.addIssue({ code: "custom", message: "Integrity must be a valid SHA-512 SRI value" });
  }
});

export const internalNpmSourceSchema = z
  .strictObject({
    ...versionedDocumentFields("web-doctor.npm-source", 1),
    registry: z.literal("internal"),
    packageName: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    integrity: npmIntegritySchema,
    provenance: sourceProvenanceSchema,
  })
  .superRefine((source, context) => {
    try {
      const parsed = npa.resolve(source.packageName, source.version);
      if (parsed.type !== "version" || parsed.registry !== true || parsed.name !== source.packageName) {
        context.addIssue({
          code: "custom",
          path: ["version"],
          message: "Source must use a valid npm package name and exact version",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["packageName"],
        message: "Source must use a valid npm package name and exact version",
      });
    }
  });

export const sourceLocationSchema = z.strictObject({
  path: nonEmptyStringSchema,
  line: z.int().positive().optional(),
  column: z.int().positive().optional(),
  endLine: z.int().positive().optional(),
  endColumn: z.int().positive().optional(),
});

export const packageArtifactReferenceSchema = z.strictObject({
  path: packagePathSchema,
  digest: digestSchema,
});

export const compatibilitySchema = z.strictObject({
  webDoctor: nonEmptyStringSchema,
  engines: z.record(nonEmptyStringSchema, nonEmptyStringSchema).optional(),
});

export const applicabilitySchema = z.strictObject({
  portals: z
    .strictObject({
      anyOf: z.array(identifierSchema).min(1),
    })
    .optional(),
  files: z
    .strictObject({
      include: z.array(nonEmptyStringSchema).min(1).optional(),
      exclude: z.array(nonEmptyStringSchema).min(1).optional(),
    })
    .optional(),
  capabilities: z
    .array(
      z.strictObject({
        name: identifierSchema,
        range: nonEmptyStringSchema.optional(),
      }),
    )
    .optional(),
  dependencies: z
    .array(
      z.strictObject({
        name: nonEmptyStringSchema,
        range: nonEmptyStringSchema,
      }),
    )
    .optional(),
  runtimes: z
    .array(
      z.strictObject({
        name: identifierSchema,
        range: nonEmptyStringSchema,
      }),
    )
    .optional(),
  applicationMetadata: z.record(nonEmptyStringSchema, z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export type SchemaVersionEnvelope = z.infer<typeof schemaVersionEnvelopeSchema>;
export type InternalNpmSource = z.infer<typeof internalNpmSourceSchema>;