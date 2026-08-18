/**
 * The exact semver shape `parseSemverFields` accepts for release semver_*
 * fields: `major.minor.patch` with optional prerelease and build segments.
 * Shared with the mirror-tag filter so a tag is listed only when seeding
 * could actually parse its semver — listing and seeding can never disagree.
 * Pure — unit tested.
 */
export const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** True when `version` parses as a release semver (what `parseSemverFields` enforces). */
export const isSemverVersion = (version: string): boolean => SEMVER_PATTERN.test(version.trim());
