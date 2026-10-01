import { type VersionedFile } from "../core";
export declare function readVersioned<T>(path: string, knownMax?: number): VersionedFile<T>;
