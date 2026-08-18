declare module 'balena-semver' {
  export interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
    build: string[];
    version: string;
    raw: string;
    revision?: number | null;
  }

  export function compare(v: string, w: string): number;
  export function rcompare(v: string, w: string): number;
  export function gt(v: string, w: string): boolean;
  export function gte(v: string, w: string): boolean;
  export function lt(v: string, w: string): boolean;
  export function lte(v: string, w: string): boolean;
  export function eq(v: string, w: string): boolean;
  export function valid(v: string): boolean;
  export function parse(v: string): ParsedSemver | null;
  export function major(v: string): number;
  export function prerelease(v: string): string[];
  export function getRevision(v: string): number | null;
  export function satisfies(v: string, range: string): boolean;
  export function maxSatisfying<T extends string>(versions: T[], range: string): T | null;
  export function inc(v: string, release: string): string;
}
